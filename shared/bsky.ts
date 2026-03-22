import type { AppBskyActorDefs } from "@atcute/bluesky";
import { Client, ok, simpleFetchHandler } from "@atcute/client";
import { isActorIdentifier } from "@atcute/lexicons/syntax";
import type { ActorIdentifier } from "@atcute/lexicons/syntax";

export type { ActorIdentifier } from "@atcute/lexicons/syntax";
export type ProfileView = AppBskyActorDefs.ProfileView;
export type ProfileViewDetailed = AppBskyActorDefs.ProfileViewDetailed;

export const rpc = new Client({
    handler: simpleFetchHandler({ service: "https://public.api.bsky.app" }),
});

export function chunked<A>(array: A[], size: number): A[][] {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

export const profilePrefix = "https://bsky.app/profile/";

export const avatarFallback =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='12' fill='%230070ff'/%3E%3Ccircle cx='12' cy='9.5' r='3.5' fill='%23fff'/%3E%3Cpath fill='%23fff' d='M 12.058 22.784 C 9.422 22.784 7.007 21.836 5.137 20.262 C 5.667 17.988 8.534 16.25 11.99 16.25 C 15.494 16.25 18.391 18.036 18.864 20.357 C 17.01 21.874 14.64 22.784 12.058 22.784 Z'/%3E%3C/svg%3E";

export function cleanHandle(value: string): ActorIdentifier {
    value = value.trim().toLowerCase();
    if (value.startsWith(profilePrefix)) {
        value = value.slice(profilePrefix.length).split("/")[0];
    }
    if (value.startsWith("@")) {
        value = value.slice(1);
    }
    if (value.startsWith("at://")) {
        value = value.slice("at://".length);
    }
    if (!isActorIdentifier(value)) {
        throw new Error(`Invalid handle: ${value}`);
    }
    return value;
}

export async function getProfile(handle: string, signal?: AbortSignal): Promise<ProfileViewDetailed> {
    const actor = cleanHandle(handle);
    return ok(rpc.get("app.bsky.actor.getProfile", { params: { actor }, signal }));
}

export const isEngagementHacker = (profile: ProfileViewDetailed) => {
    const follows = profile.followsCount ?? 0;
    const followers = profile.followersCount ?? 0;
    if (follows > 10_000) return true;
    return follows > 2_000 && followers > 0 && follows / followers > 3;
};

export async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
}

export async function getProfiles(
    actors: ActorIdentifier[],
    signal?: AbortSignal,
): Promise<Map<ActorIdentifier, ProfileViewDetailed>> {
    const map = new Map<ActorIdentifier, ProfileViewDetailed>();
    const chunks = chunked(actors, 25);
    const results = await mapConcurrent(
        chunks,
        5,
        (chunk) => ok(rpc.get("app.bsky.actor.getProfiles", { params: { actors: chunk }, signal })),
    );
    for (const { profiles } of results) {
        for (const profile of profiles) {
            map.set(profile.did, profile);
        }
    }
    return map;
}

const paginate = async (
    endpoint: "app.bsky.graph.getFollowers" | "app.bsky.graph.getFollows",
    actor: ActorIdentifier,
    onProgress?: (info: { current: number; }) => void,
    signal?: AbortSignal,
): Promise<Map<ActorIdentifier, ProfileView>> => {
    const all = new Map<ActorIdentifier, ProfileView>();
    let cursor: string | undefined;
    do {
        const res = await ok(rpc.get(endpoint, {
            params: { actor, limit: 100, cursor },
            signal,
        }));
        const profiles = "followers" in res ? res.followers : res.follows;
        for (const f of profiles) {
            all.set(f.did, f);
        }
        cursor = res.cursor;
        onProgress?.({ current: all.size });
    } while (cursor);
    return all;
};

export const getAllFollows = (
    actor: ActorIdentifier,
    onProgress?: (info: { current: number; }) => void,
    signal?: AbortSignal,
) => paginate("app.bsky.graph.getFollows", actor, onProgress, signal);

export const getAllFollowers = (
    actor: ActorIdentifier,
    onProgress?: (info: { current: number; }) => void,
    signal?: AbortSignal,
) => paginate("app.bsky.graph.getFollowers", actor, onProgress, signal);
