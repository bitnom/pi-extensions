// channel.test.ts — the local delivery channel.
//
// The channel is the only way a request reaches another session's process. These
// tests are about the channel itself: where the socket is, what the request carries,
// and what the caller is told when the other end is gone, busy, or speaks nonsense.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelRequest, ensureSocketDir, sendRequest, socketDir, socketPathFor } from "./channel.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const OTHER_ID = "99999999-8888-7777-6666-555555555555";

function request(overrides: Partial<ChannelRequest> = {}): ChannelRequest {
	return {
		requestId: "req-1",
		tool: "set_session_thinking",
		sessionId: ID,
		sessionPath: "/tmp/ft55/session.jsonl",
		action: "set_thinking",
		level: "high",
		...overrides,
	};
}

describe("where the socket is", () => {
	test("the socket path is derived from the session id, and says nothing about it", () => {
		const dir = socketDir();
		const path = socketPathFor(ID, dir);
		expect(path).toBe(socketPathFor(ID, dir));
		expect(path).not.toBe(socketPathFor(OTHER_ID, dir));
		expect(path).not.toContain(ID);
		expect(path.startsWith(dir)).toBe(true);
	});

	test("the socket directory is the runtime directory, when there is one", () => {
		expect(socketDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/pi-parameter-tools");
		// A relative runtime directory is not a directory: the temporary directory is
		// used instead.
		expect(socketDir({ XDG_RUNTIME_DIR: "relative" })).toBe(join(tmpdir(), "pi-parameter-tools"));
		expect(socketDir({})).toBe(join(tmpdir(), "pi-parameter-tools"));
	});
});

describe("asking a receiver", () => {
	test("the request carries the caller's request id, the tool and the binding", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const seen: { value: ChannelRequest | null } = { value: null };
		const server: Server = createServer((socket: Socket) => {
			socket.on("data", (chunk: Buffer) => {
				seen.value = JSON.parse(chunk.toString("utf8").split("\n")[0] ?? "{}") as ChannelRequest;
				socket.write(`${JSON.stringify({ ok: true, result: { applied: "thinking" } })}\n`);
				socket.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(ID, dir), resolve));
		try {
			const response = await sendRequest({ sessionId: ID, request: request(), dir });
			expect(response.ok).toBe(true);
			expect(response.result?.applied).toBe("thinking");
			expect(seen.value?.requestId).toBe("req-1");
			expect(seen.value?.tool).toBe("set_session_thinking");
			expect(seen.value?.sessionId).toBe(ID);
			expect(seen.value?.sessionPath).toBe("/tmp/ft55/session.jsonl");
			expect(seen.value?.action).toBe("set_thinking");
			expect(seen.value?.level).toBe("high");
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a target that is not listening is reported as unavailable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		try {
			const response = await sendRequest({ sessionId: ID, request: request(), dir, timeoutMs: 1000 });
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("receiver_unavailable");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a target that does not answer is a timeout, not a hang", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const server: Server = createServer(() => {
			// accept, and say nothing
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(ID, dir), resolve));
		try {
			const started = Date.now();
			const response = await sendRequest({ sessionId: ID, request: request(), dir, timeoutMs: 250 });
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("target_timeout");
			expect(Date.now() - started).toBeLessThan(3000);
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an answer this build cannot read is a protocol error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const server: Server = createServer((socket: Socket) => {
			socket.on("data", () => {
				socket.write("this is not json\n");
				socket.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(ID, dir), resolve));
		try {
			const response = await sendRequest({ sessionId: ID, request: request(), dir, timeoutMs: 1000 });
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("target_protocol_error");
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a target that closes without answering is unreachable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		const server: Server = createServer((socket: Socket) => {
			socket.on("data", () => {
				socket.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPathFor(ID, dir), resolve));
		try {
			const response = await sendRequest({ sessionId: ID, request: request(), dir, timeoutMs: 1000 });
			expect(response.ok).toBe(false);
			expect(response.refusal?.code).toBe("target_unreachable");
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the socket directory is created private to this user", () => {
		const dir = mkdtempSync(join(tmpdir(), "ft55-channel-"));
		try {
			const socketDirPath = ensureSocketDir(join(dir, "pi-parameter-tools"));
			expect(existsSync(socketDirPath)).toBe(true);
			expect(statSync(socketDirPath).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
