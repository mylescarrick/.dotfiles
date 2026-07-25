import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WEB_TOOLS_AUTH_FILENAME = "web-tools-auth.json";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Read the unresolved Exa API key reference from private web-tools auth state, if configured. */
export function readExaApiKeyRef(): string | undefined {
	let raw: string;
	try {
		raw = readFileSync(join(agentDir(), WEB_TOOLS_AUTH_FILENAME), "utf8");
	} catch {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}

	const key = (parsed as { readonly exa?: { readonly key?: unknown } } | null)?.exa?.key;
	return typeof key === "string" && key.length > 0 ? key : undefined;
}

/** Resolve a stored key reference: "!<command>" runs a shell command, "$NAME" reads an env var, else literal. */
async function resolveExaApiKey(ref: string): Promise<string | undefined> {
	if (ref.startsWith("!")) {
		const { stdout } = await execFileAsync("sh", ["-c", ref.slice(1)]);
		const resolved = stdout.trim();
		return resolved.length > 0 ? resolved : undefined;
	}
	if (ref.startsWith("$")) {
		return process.env[ref.slice(1)];
	}
	return ref;
}

let cachedRef: string | undefined;
let cachedResolution: Promise<string | undefined> | undefined;

/** Resolve a stored key reference once per process, reusing the result for subsequent calls with the same ref. */
export function resolveExaApiKeyCached(ref: string): Promise<string | undefined> {
	if (cachedRef !== ref) {
		cachedRef = ref;
		cachedResolution = resolveExaApiKey(ref);
	}
	return cachedResolution!;
}
