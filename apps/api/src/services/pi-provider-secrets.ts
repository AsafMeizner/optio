import { PI_PROVIDER_KEYS } from "@optio/agent-adapters";

/** Pi takes any one provider key, or the credential explicitly selected for this work. */
export async function piProviderSecrets(
  secret: (name: string) => Promise<string | null>,
  credential?: { env: Record<string, string> } | null,
): Promise<Record<string, string>> {
  if (credential) return { ...credential.env };
  const found: Record<string, string> = {};
  for (const name of PI_PROVIDER_KEYS) {
    const value = await secret(name);
    if (value) found[name] = value;
  }
  if (!Object.keys(found).length) {
    throw new Error(`Pi needs one of ${PI_PROVIDER_KEYS.join(", ")} as a secret`);
  }
  return found;
}
