import type { ActorIdentifier, Did } from "@atcute/lexicons/syntax";
import { isDid } from "@atcute/lexicons/syntax";
import * as v from "valibot";
import { mapConcurrent, type ProfileView } from "../../shared/bsky";

const plcDirectory = "https://plc.directory";
const miniDocUrl = "https://slingshot.microcosm.blue/xrpc/blue.microcosm.identity.resolveMiniDoc";
const blockCollection = "app.bsky.graph.block";
const scanConcurrency = 12;
const requestTimeout = 8_000;
const maxRetryWait = 10_000;

const PlcDocument = v.object({
    id: v.string(),
    service: v.array(v.object({ id: v.string(), type: v.string(), serviceEndpoint: v.unknown() })),
});

const MiniDoc = v.object({ did: v.string(), pds: v.string() });

const BlockPage = v.object({
    records: v.array(v.object({ value: v.object({ subject: v.custom<Did>(isDid) }) })),
    cursor: v.optional(v.string()),
});

export interface BlockPair {
    first: ProfileView;
    second: ProfileView;
    firstBlocksSecond: boolean;
    secondBlocksFirst: boolean;
}

export interface UncheckedAccount {
    profile: ProfileView;
    reason: string;
}

export interface ScanProgress {
    checked: number;
    total: number;
    pages: number;
    pairs: BlockPair[];
    unchecked: UncheckedAccount[];
}

function getPairHandles(pair: BlockPair): [string, string] {
    return pair.first.handle.localeCompare(pair.second.handle) <= 0
        ? [pair.first.handle, pair.second.handle]
        : [pair.second.handle, pair.first.handle];
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        const abort = () => {
            clearTimeout(timeout);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
}

function retryAfterMilliseconds(value: string | null): number {
    if (value === null) return 0;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
    return delay > 0 ? delay : 0;
}

function createJsonReader(signal?: AbortSignal) {
    const hosts = new Map<string, { nextStart: number; retryAt: number; }>();

    return async (url: URL): Promise<unknown> => {
        const hostKey = url.hostname;
        const host = hosts.get(hostKey) ?? { nextStart: 0, retryAt: 0 };
        hosts.set(hostKey, host);

        for (let attempt = 0;; attempt++) {
            while (true) {
                signal?.throwIfAborted();
                const now = performance.now();
                if (host.retryAt - now > maxRetryWait) {
                    throw new Error(`${hostKey} asked the scanner to retry later`);
                }
                const delay = Math.max(host.nextStart, host.retryAt) - now;
                if (delay <= 0) {
                    host.nextStart = now + (url.origin === plcDirectory ? 75 : 110);
                    break;
                }
                await wait(delay, signal);
            }

            const timeout = AbortSignal.timeout(requestTimeout);
            const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
            const response = await fetch(url, {
                signal: requestSignal,
                credentials: "omit",
                redirect: "error",
                referrerPolicy: "no-referrer",
            });
            if (response.ok) return response.json();

            const retryable = response.status === 429 || response.status >= 500;
            if (retryable) {
                const delay = Math.max(500 * 2 ** attempt, retryAfterMilliseconds(response.headers.get("Retry-After")));
                host.retryAt = Math.max(host.retryAt, performance.now() + delay);
            }
            await response.body?.cancel();
            if (!retryable || attempt >= 2) throw new Error(`${hostKey} returned HTTP ${response.status}`);
        }
    };
}

type ReadJson = ReturnType<typeof createJsonReader>;

async function resolvePds(did: Did, readJson: ReadJson): Promise<URL> {
    let endpoint: unknown;
    if (/^did:plc:[a-z2-7]{24}$/.test(did)) {
        const doc = v.parse(PlcDocument, await readJson(new URL(`/${did}`, plcDirectory)));
        if (doc.id !== did) throw new Error("PLC document did not match the account");
        endpoint = doc.service.find((service) =>
            (service.id === "#atproto_pds" || service.id === `${did}#atproto_pds`)
            && service.type === "AtprotoPersonalDataServer"
        )?.serviceEndpoint;
    } else if (did.startsWith("did:web:")) {
        const url = new URL(miniDocUrl);
        url.searchParams.set("identifier", did);
        const doc = v.parse(MiniDoc, await readJson(url));
        if (doc.did !== did) throw new Error("Resolved identity did not match the account");
        endpoint = doc.pds;
    } else {
        throw new Error("Unsupported DID method");
    }

    if (typeof endpoint !== "string") throw new Error("No data server listed for the account");
    const pds = new URL(endpoint);
    // The endpoint comes from a public DID document. Send only credential-free reads to HTTPS DNS hosts.
    if (
        pds.protocol !== "https:" || pds.username || pds.password || pds.pathname !== "/" || pds.search || pds.hash
        || !/\.[a-z][a-z0-9-]*$/i.test(pds.hostname) || /\.(localhost|local|internal)$/i.test(pds.hostname)
    ) {
        throw new Error("Invalid public HTTPS data server endpoint");
    }
    return pds;
}

export async function findBlockPairs(
    followed: Map<ActorIdentifier, ProfileView>,
    onProgress?: (progress: ScanProgress) => void,
    signal?: AbortSignal,
): Promise<ScanProgress> {
    const pairs = new Map<string, BlockPair>();
    const readJson = createJsonReader(signal);
    const total = followed.size;
    let checked = 0;
    let pages = 0;
    let sortedPairs: BlockPair[] = [];
    let unchecked: UncheckedAccount[] = [];

    const snapshot = (): ScanProgress => ({ checked, total, pages, pairs: sortedPairs, unchecked });

    await mapConcurrent([...followed.values()], scanConcurrency, async (blocker) => {
        try {
            const pds = await resolvePds(blocker.did, readJson);
            const url = new URL("/xrpc/com.atproto.repo.listRecords", pds);
            url.search = new URLSearchParams({ repo: blocker.did, collection: blockCollection, limit: "100" })
                .toString();
            const seenCursors = new Set<string>();
            while (true) {
                const { records, cursor } = v.parse(BlockPage, await readJson(url));
                signal?.throwIfAborted();
                pages++;
                let changed = false;
                for (const { value: { subject } } of records) {
                    if (subject === blocker.did) continue;
                    const blocked = followed.get(subject);
                    if (!blocked) continue;
                    const blockerFirst = blocker.did < subject;
                    const first = blockerFirst ? blocker : blocked;
                    const second = blockerFirst ? blocked : blocker;
                    const key = `${first.did}\0${second.did}`;
                    const previous = pairs.get(key);
                    if (blockerFirst ? previous?.firstBlocksSecond : previous?.secondBlocksFirst) continue;
                    pairs.set(key, {
                        first,
                        second,
                        firstBlocksSecond: blockerFirst || (previous?.firstBlocksSecond ?? false),
                        secondBlocksFirst: !blockerFirst || (previous?.secondBlocksFirst ?? false),
                    });
                    changed = true;
                }
                if (changed) {
                    sortedPairs = [...pairs.values()].sort((a, b) => {
                        const [aFirst, aSecond] = getPairHandles(a);
                        const [bFirst, bSecond] = getPairHandles(b);
                        return aFirst.localeCompare(bFirst) || aSecond.localeCompare(bSecond);
                    });
                }
                if (!cursor) break;
                if (seenCursors.has(cursor)) throw new Error("Data server returned a repeated block page cursor");
                seenCursors.add(cursor);
                url.searchParams.set("cursor", cursor);
                if (changed) onProgress?.(snapshot());
            }
            checked++;
        } catch (error) {
            signal?.throwIfAborted();
            unchecked = [...unchecked, {
                profile: blocker,
                reason: error instanceof Error ? error.message : String(error),
            }].sort((a, b) => a.profile.handle.localeCompare(b.profile.handle));
        }
        onProgress?.(snapshot());
    });

    return snapshot();
}
