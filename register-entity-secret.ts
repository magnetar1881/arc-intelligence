import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

async function main() {
  const apiKey: string | undefined = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    throw new Error("CIRCLE_API_KEY is required. Set it in .env first.");
  }

  const existingEnv: string = existsSync(".env")
    ? readFileSync(".env", "utf8")
    : "";
  if (/^CIRCLE_ENTITY_SECRET=/m.test(existingEnv)) {
    throw new Error(
      "CIRCLE_ENTITY_SECRET already exists in .env. Refusing to overwrite it."
    );
  }

  const entitySecret: string = randomBytes(32).toString("hex");
  const recoveryFilePath: string = "./recovery";

  mkdirSync(recoveryFilePath, { recursive: true });

  await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: recoveryFilePath,
  });

  appendFileSync(".env", `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);

  console.log("Entity secret registered.");
  console.log(`Recovery file saved to a new file in: ${recoveryFilePath}`);
  console.log("CIRCLE_ENTITY_SECRET added to .env");
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
