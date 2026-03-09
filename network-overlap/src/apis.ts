import { Client, ok, simpleFetchHandler } from "@atcute/client";
import type {} from "@atcute/bluesky";
import type { AppBskyActorDefs } from "@atcute/bluesky";
export type { ActorIdentifier } from "@atcute/lexicons/syntax";
import type { ActorIdentifier } from "@atcute/lexicons/syntax";

export type ProfileView = AppBskyActorDefs.ProfileView;
export type ProfileViewDetailed = AppBskyActorDefs.ProfileViewDetailed;

const rpc = new Client({
    handler: simpleFetchHandler({ service: "https://public.api.bsky.app" }),
});

export const getProfile = async (actor: ActorIdentifier): Promise<ProfileViewDetailed> => {
    return ok(rpc.get("app.bsky.actor.getProfile", { params: { actor } }));
};

function chunked<A>(array: A[], size: number): A[][] {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

export const getProfiles = async (actors: ActorIdentifier[]): Promise<Map<string, ProfileViewDetailed>> => {
    const map = new Map<string, ProfileViewDetailed>();
    const chunks = chunked(actors, 25);
    // Fetch all chunks in parallel
    const results = await Promise.all(
        chunks.map((chunk) => ok(rpc.get("app.bsky.actor.getProfiles", { params: { actors: chunk } }))),
    );
    for (const { profiles } of results) {
        for (const profile of profiles) {
            map.set(profile.did, profile);
        }
    }
    return map;
};

export interface ProgressInfo {
    phase: string;
    current: number;
    total?: number;
    profile?: ProfileViewDetailed;
}

export const getAllFollowers = async (
    actor: ActorIdentifier,
    onProgress?: (info: ProgressInfo) => void,
): Promise<Map<string, ProfileView>> => {
    const all = new Map<string, ProfileView>();
    let cursor: string | undefined;
    do {
        const res = await ok(rpc.get("app.bsky.graph.getFollowers", {
            params: { actor, limit: 100, cursor },
        }));
        for (const f of res.followers) {
            all.set(f.did, f);
        }
        cursor = res.cursor;
        onProgress?.({ phase: "followers", current: all.size });
    } while (cursor);
    return all;
};

export const getAllFollows = async (
    actor: ActorIdentifier,
    onProgress?: (info: ProgressInfo) => void,
): Promise<Map<string, ProfileView>> => {
    const all = new Map<string, ProfileView>();
    let cursor: string | undefined;
    do {
        const res = await ok(rpc.get("app.bsky.graph.getFollows", {
            params: { actor, limit: 100, cursor },
        }));
        for (const f of res.follows) {
            all.set(f.did, f);
        }
        cursor = res.cursor;
        onProgress?.({ phase: "follows", current: all.size });
    } while (cursor);
    return all;
};

export interface NetworkData {
    profile: ProfileViewDetailed;
    followers: Map<string, ProfileView>;
    follows: Map<string, ProfileView>;
}

export interface OverlapResult {
    profileA: ProfileViewDetailed;
    profileB: ProfileViewDetailed;
    sharedFollowers: ProfileViewDetailed[];
    sharedFollows: ProfileViewDetailed[];
    sharedMutuals: ProfileViewDetailed[];
    onlyAFollows: ProfileViewDetailed[];
    onlyBFollows: ProfileViewDetailed[];
    followersA: number;
    followersB: number;
    followsA: number;
    followsB: number;
}

export const fetchNetworkData = async (
    actor: ActorIdentifier,
    onProgress?: (info: ProgressInfo) => void,
): Promise<NetworkData> => {
    const profile = await getProfile(actor);
    onProgress?.({ phase: "profile", current: 0, total: profile.followersCount, profile });
    const [followers, follows] = await Promise.all([
        getAllFollowers(actor, (info) => {
            onProgress?.({ ...info, total: profile.followersCount });
        }),
        getAllFollows(actor, (info) => {
            onProgress?.({ ...info, total: profile.followsCount });
        }),
    ]);
    return { profile, followers, follows };
};

export const computeOverlap = (a: NetworkData, b: NetworkData): OverlapResult => {
    const sharedFollowerDids: string[] = [];
    for (const did of a.followers.keys()) {
        if (b.followers.has(did)) sharedFollowerDids.push(did);
    }

    const sharedFollowDids: string[] = [];
    const onlyAFollowDids: string[] = [];
    for (const did of a.follows.keys()) {
        if (b.follows.has(did)) {
            sharedFollowDids.push(did);
        } else {
            onlyAFollowDids.push(did);
        }
    }

    const onlyBFollowDids: string[] = [];
    for (const did of b.follows.keys()) {
        if (!a.follows.has(did)) {
            onlyBFollowDids.push(did);
        }
    }

    // Shared mutuals: people both users follow AND are followed by
    const sharedMutualDids = sharedFollowDids.filter(
        (did) => a.followers.has(did) && b.followers.has(did),
    );

    const pickProfile = (
        did: string,
        mapA: Map<string, ProfileView>,
        mapB: Map<string, ProfileView>,
    ): ProfileView => {
        return mapA.get(did) ?? mapB.get(did)!;
    };

    const sharedFollowers = sharedFollowerDids.map((did) => pickProfile(did, a.followers, b.followers));
    const sharedFollows = sharedFollowDids.map((did) => pickProfile(did, a.follows, b.follows));
    const sharedMutuals = sharedMutualDids.map((did) => pickProfile(did, a.follows, b.follows));
    const onlyAFollows = onlyAFollowDids.map((did) => a.follows.get(did)!);
    const onlyBFollows = onlyBFollowDids.map((did) => b.follows.get(did)!);

    return {
        profileA: a.profile,
        profileB: b.profile,
        sharedFollowers: sharedFollowers as ProfileViewDetailed[],
        sharedFollows: sharedFollows as ProfileViewDetailed[],
        sharedMutuals: sharedMutuals as ProfileViewDetailed[],
        onlyAFollows: onlyAFollows as ProfileViewDetailed[],
        onlyBFollows: onlyBFollows as ProfileViewDetailed[],
        followersA: a.followers.size,
        followersB: b.followers.size,
        followsA: a.follows.size,
        followsB: b.follows.size,
    };
};
