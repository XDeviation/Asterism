import type { BoardIdentity, BoardRecord, SyncedMessage } from "@asterism/shared";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Message,
  type PartialMessage,
} from "discord.js";
import { AppApiClient } from "./api.js";
import type { BotConfig } from "./config.js";
import { BotDatabase } from "./database.js";
import { normalizeMessage, shouldSyncMessage } from "./messages.js";
import { OutboxProcessor } from "./outbox.js";

function isSyncableChannel(channel: unknown): channel is GuildTextBasedChannel {
  if (!channel || typeof channel !== "object") return false;
  const candidate = channel as GuildTextBasedChannel;
  return (
    typeof candidate.isTextBased === "function" &&
    candidate.isTextBased() &&
    "messages" in candidate &&
    "guild" in candidate
  );
}

function boardIdentity(channel: GuildTextBasedChannel): BoardIdentity {
  const category = channel.isThread() ? channel.parent?.parent : channel.parent;
  return {
    guildId: channel.guild.id,
    guildName: channel.guild.name,
    channelId: channel.id,
    channelName: channel.name,
    categoryId: category?.type === ChannelType.GuildCategory ? category.id : null,
    categoryName: category?.type === ChannelType.GuildCategory ? category.name : null,
  };
}

function sortMessages(messages: Message[]): Message[] {
  return messages.sort((left, right) =>
    BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0,
  );
}

export class AsterismBot {
  readonly client: Client;
  readonly database: BotDatabase;
  readonly api: AppApiClient;
  readonly outbox: OutboxProcessor;
  #maintenanceTimer: NodeJS.Timeout | null = null;
  #imageTimer: NodeJS.Timeout | null = null;
  #maintenanceRunning = false;

  constructor(private readonly config: BotConfig) {
    this.database = new BotDatabase(config.databasePath);
    this.api = new AppApiClient(config.appApiUrl, config.serviceToken);
    this.outbox = new OutboxProcessor(this.database, this.api);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.attachListeners();
  }

  async start(): Promise<void> {
    this.outbox.start();
    await this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
    if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer);
    if (this.#imageTimer) clearInterval(this.#imageTimer);
    this.outbox.stop();
    this.client.destroy();
    this.database.close();
  }

  private attachListeners(): void {
    this.client.once(Events.ClientReady, (client) => {
      console.info(`Discord bot ready as ${client.user.tag}`);
      void this.onReady();
    });

    this.client.on(Events.GuildCreate, (guild) => {
      if (guild.id === this.config.guildId) {
        this.api.syncGuild(guild.id, guild.name).catch(console.error);
      }
    });

    this.client.on(Events.ChannelCreate, (channel) => {
      if (!("guild" in channel) || channel.guild.id !== this.config.guildId) return;
      if (channel.type === ChannelType.GuildCategory) {
        this.api.syncCategory(channel.guild.id, channel.id, channel.name).catch(console.error);
      } else if (isSyncableChannel(channel)) {
        const boardId = this.database.getBoardId(channel.guild.id, channel.id);
        const categoryId = channel.parent?.type === ChannelType.GuildCategory ? channel.parent.id : null;
        if (boardId) {
          this.api.syncChannel(channel.guild.id, categoryId, channel.id, boardId, channel.name).catch(console.error);
        }
      }
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand() && interaction.commandName === "board") {
        void this.handleBoardCommand(interaction);
      }
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.syncMessage(message);
    });

    this.client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
      void this.syncPartialMessage(newMessage);
    });

    this.client.on(Events.MessageDelete, (message) => {
      this.deleteMessage(message);
    });

    this.client.on(Events.MessageBulkDelete, (messages) => {
      for (const message of messages.values()) this.deleteMessage(message);
    });

    this.client.on(Events.ChannelUpdate, (_oldChannel, newChannel) => {
      if (!isSyncableChannel(newChannel)) return;
      const boardId = this.database.getBoardId(newChannel.guild.id, newChannel.id);
      if (!boardId) return;
      this.enqueueBoardMetadata(newChannel);
    });

    this.client.on(Events.Error, (error) => console.error("Discord client error", error));
  }

  private async onReady(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    await guild.commands.set([
      new SlashCommandBuilder()
        .setName("board")
        .setDescription("创建或打开当前频道的协作白板")
        .setDMPermission(false)
        .toJSON(),
    ]);
    console.info(`Registered /board in ${guild.name}`);

    await this.runMaintenance();
    await this.refreshImageUrls();
    void this.backfillData();
    this.#maintenanceTimer = setInterval(() => void this.runMaintenance(), 5 * 60_000);
    this.#maintenanceTimer.unref();
    this.#imageTimer = setInterval(
      () => void this.refreshImageUrls(),
      this.config.refreshIntervalMs,
    );
    this.#imageTimer.unref();
  }

  private async handleBoardCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild() || interaction.guildId !== this.config.guildId) {
      await interaction.reply({ content: "这个 Bot 只服务已配置的队伍服务器。", ephemeral: true });
      return;
    }
    if (!isSyncableChannel(interaction.channel)) {
      await interaction.reply({ content: "请在文字频道或 Thread 中使用 `/board`。", ephemeral: true });
      return;
    }

    await interaction.deferReply();
    try {
      const response = await this.api.ensureBoard(boardIdentity(interaction.channel));
      this.database.saveMapping(response.board);
      const identity = boardIdentity(interaction.channel);
      await this.api.syncChannel(
        identity.guildId,
        identity.categoryId,
        identity.channelId,
        response.board.id,
        identity.channelName
      );
      await interaction.editReply(
        `${response.created ? "已创建" : "当前频道的"}白板：${response.boardUrl}`,
      );

      const history = await this.fetchRecentMessages(interaction.channel, 200);
      const normalized = await this.normalizeMany(history);
      if (normalized.length > 0) {
        this.enqueueBatch(response.board.id, normalized, `backfill:${response.board.id}`);
      }
      void this.outbox.drain();
    } catch (error) {
      console.error("Failed to create board", error);
      await interaction.editReply("白板服务暂时不可用，请稍后重试。");
    }
  }

  private async fetchRecentMessages(
    channel: GuildTextBasedChannel,
    count: number,
  ): Promise<Message[]> {
    const collected = new Map<string, Message>();
    let before: string | undefined;
    while (collected.size < count) {
      const limit = Math.min(100, count - collected.size);
      const page = await channel.messages.fetch(
        before ? { limit, before } : { limit },
      );
      if (page.size === 0) break;
      for (const message of page.values()) collected.set(message.id, message);
      const oldest = [...page.keys()].reduce((left, right) =>
        BigInt(left) < BigInt(right) ? left : right,
      );
      before = oldest;
      if (page.size < limit) break;
    }
    return sortMessages([...collected.values()]);
  }

  private async fetchAfter(
    channel: GuildTextBasedChannel,
    after: string,
  ): Promise<Message[]> {
    const collected = new Map<string, Message>();
    let cursor = after;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await channel.messages.fetch({ limit: 100, after: cursor });
      if (page.size === 0) break;
      const ordered = sortMessages([...page.values()]);
      for (const message of ordered) collected.set(message.id, message);
      const newest = ordered.at(-1)!.id;
      if (BigInt(newest) <= BigInt(cursor)) break;
      cursor = newest;
      if (page.size < 100) break;
    }
    return sortMessages([...collected.values()]);
  }

  private async normalizeMany(messages: Message[]): Promise<SyncedMessage[]> {
    const ownUserId = this.client.user!.id;
    const result: SyncedMessage[] = [];
    for (const message of messages) {
      if (shouldSyncMessage(message, ownUserId)) result.push(await normalizeMessage(message));
    }
    return result;
  }

  private enqueueBatch(boardId: string, messages: SyncedMessage[], key: string): void {
    this.database.enqueue(
      key,
      "PUT",
      `/api/internal/boards/${encodeURIComponent(boardId)}/messages`,
      { messages },
    );
  }

  private enqueueBoardMetadata(channel: GuildTextBasedChannel): void {
    this.database.enqueue(
      `board-meta:${channel.id}`,
      "POST",
      "/api/internal/boards/ensure",
      boardIdentity(channel),
    );
    void this.outbox.drain();
  }

  private async syncMessage(message: Message): Promise<void> {
    if (!this.client.user || !shouldSyncMessage(message, this.client.user.id)) return;
    if (message.guildId !== this.config.guildId) return;
    const boardId = this.database.getBoardId(message.guildId, message.channelId);
    if (!boardId) return;
    try {
      const normalized = await normalizeMessage(message);
      this.enqueueBatch(boardId, [normalized], `message:${message.id}`);
      void this.outbox.drain();
    } catch (error) {
      console.error("Failed to normalize Discord message", { messageId: message.id, error });
    }
  }

  private async syncPartialMessage(message: Message | PartialMessage): Promise<void> {
    try {
      const complete = message.partial ? await message.fetch() : message;
      await this.syncMessage(complete);
    } catch (error) {
      console.error("Failed to fetch edited message", { messageId: message.id, error });
    }
  }

  private deleteMessage(message: Message | PartialMessage): void {
    if (!message.guildId || message.guildId !== this.config.guildId) return;
    const boardId = this.database.getBoardId(message.guildId, message.channelId);
    if (!boardId) return;
    this.database.enqueue(
      `delete:${message.id}`,
      "DELETE",
      `/api/internal/boards/${encodeURIComponent(boardId)}/messages/${message.id}`,
    );
    void this.outbox.drain();
  }

  private async backfillData(): Promise<void> {
    for (const guild of this.client.guilds.cache.values()) {
      if (guild.id !== this.config.guildId) continue;
      await this.api.syncGuild(guild.id, guild.name).catch(console.error);
      const channels = await guild.channels.fetch().catch(console.error);
      if (!channels) continue;
      for (const channel of channels.values()) {
        if (!channel) continue;
        if (channel.type === ChannelType.GuildCategory) {
          await this.api.syncCategory(guild.id, channel.id, channel.name).catch(console.error);
        } else if (isSyncableChannel(channel)) {
          const boardId = this.database.getBoardId(guild.id, channel.id);
          if (boardId) {
            const categoryId = channel.parent?.type === ChannelType.GuildCategory ? channel.parent.id : null;
            await this.api.syncChannel(guild.id, categoryId, channel.id, boardId, channel.name).catch(console.error);
          }
        }
      }
    }
  }

  private async runMaintenance(): Promise<void> {
    if (this.#maintenanceRunning) return;
    this.#maintenanceRunning = true;
    try {
      const boards = await this.api.listBoards();
      for (const board of boards) {
        if (board.guildId !== this.config.guildId) continue;
        this.database.saveMapping(board);
        await this.recoverBoard(board);
      }
      void this.outbox.drain();
    } catch (error) {
      console.error("Board recovery postponed", error);
    } finally {
      this.#maintenanceRunning = false;
    }
  }

  private async recoverBoard(board: BoardRecord): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(board.channelId);
      if (!isSyncableChannel(channel)) return;
      this.enqueueBoardMetadata(channel);
      const missed = board.lastSyncedMessageId
        ? await this.fetchAfter(channel, board.lastSyncedMessageId)
        : await this.fetchRecentMessages(channel, 200);
      const normalized = await this.normalizeMany(missed);
      if (normalized.length > 0) {
        this.enqueueBatch(
          board.id,
          normalized,
          `recovery:${board.id}:${normalized.at(-1)!.id}`,
        );
      }
    } catch (error) {
      console.error("Failed to recover board messages", { boardId: board.id, error });
    }
  }

  private async refreshImageUrls(): Promise<void> {
    try {
      const candidates = await this.api.listRefreshCandidates();
      const uniqueMessages = new Map<
        string,
        { boardId: string; channelId: string; messageId: string }
      >();
      for (const image of candidates) {
        uniqueMessages.set(image.messageId, image);
      }
      for (const candidate of uniqueMessages.values()) {
        try {
          const channel = await this.client.channels.fetch(candidate.channelId);
          if (!isSyncableChannel(channel)) continue;
          const message = await channel.messages.fetch(candidate.messageId);
          if (!this.client.user || !shouldSyncMessage(message, this.client.user.id)) continue;
          const normalized = await normalizeMessage(message);
          this.enqueueBatch(
            candidate.boardId,
            [normalized],
            `message:${candidate.messageId}`,
          );
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === 10_008
          ) {
            this.database.enqueue(
              `delete:${candidate.messageId}`,
              "DELETE",
              `/api/internal/boards/${encodeURIComponent(candidate.boardId)}/messages/${candidate.messageId}`,
            );
            continue;
          }
          console.error("Failed to refresh image URL", { candidate, error });
        }
      }
      void this.outbox.drain();
    } catch (error) {
      console.error("Image URL refresh postponed", error);
    }
  }
}
