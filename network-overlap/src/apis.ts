import { ok } from "@atcute/client";
import type { ActorIdentifier } from "@atcute/lexicons/syntax";
import { getProfile, getProfiles, type ProfileView, type ProfileViewDetailed, rpc } from "../../shared/bsky";

export { type ActorIdentifier, getProfiles, type ProfileView, type ProfileViewDetailed } from "../../shared/bsky";

export interface ProgressInfo {
    profile?: ProfileViewDetailed;
    followers?: number;
    follows?: number;
}

export const getAllFollowers = async (
    actor: ActorIdentifier,
    onProgress?: (info: { current: number; }) => void,
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
        onProgress?.({ current: all.size });
    } while (cursor);
    return all;
};

export const getAllFollows = async (
    actor: ActorIdentifier,
    onProgress?: (info: { current: number; }) => void,
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
        onProgress?.({ current: all.size });
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
    onProgress?.({ profile });
    const progress: ProgressInfo = { profile };
    const [followers, follows] = await Promise.all([
        getAllFollowers(actor, (info) => {
            progress.followers = info.current;
            onProgress?.({ ...progress });
        }),
        getAllFollows(actor, (info) => {
            progress.follows = info.current;
            onProgress?.({ ...progress });
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
