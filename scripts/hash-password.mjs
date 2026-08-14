import argon2 from "argon2";

const password = process.env.ASTERISM_PASSWORD;
if (!password) {
  console.error("Set ASTERISM_PASSWORD before running this command.");
  process.exit(1);
}

console.log(await argon2.hash(password, { type: argon2.argon2id }));

