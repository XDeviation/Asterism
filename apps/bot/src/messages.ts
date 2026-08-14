import type { SyncedImage, SyncedMessage } from "@asterism/shared";
import type { Message } from "discord.js";

function attachmentExpiry(url: string): string | null {
  try {
    const encodedExpiry = new URL(url).searchParams.get("ex");
    if (!encodedExpiry) return null;
    const timestamp = Number.parseInt(encodedExpiry, 16) * 1_000;
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  } catch {
    return null;
  }
}

export function imagesFromMessage(message: Message): SyncedImage[] {
  return message.attachments
    .filter((attachment) => attachment.contentType?.startsWith("image/") === true)
    .map((attachment) => ({
      id: attachment.id,
      filename: attachment.name,
      contentType: attachment.contentType!,
      width: attachment.width,
      height: attachment.height,
      url: attachment.url,
      urlExpiresAt: attachmentExpiry(attachment.url),
    }));
}

export function shouldSyncMessage(message: Message, ownUserId: string): boolean {
  return (
    message.inGuild() &&
    !message.system &&
    message.author.id !== ownUserId
  );
}

export async function normalizeMessage(message: Message): Promise<SyncedMessage> {
  let replySummary: string | null = null;
  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference();
      const summary = referenced.cleanContent.trim().replace(/\s+/g, " ");
      replySummary = `${referenced.member?.displayName ?? referenced.author.displayName}: ${summary || "[图片]"}`
        .slice(0, 180);
    } catch {
      replySummary = "原消息不可用";
    }
  }

  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName,
    authorAvatarUrl: message.author.displayAvatarURL({ extension: "webp", size: 64 }),
    authorIsBot: message.author.bot,
    content: message.cleanContent,
    replyToId: message.reference?.messageId ?? null,
    replySummary,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    images: imagesFromMessage(message),
  };
}
