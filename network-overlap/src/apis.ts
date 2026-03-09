import { ok } from "@atcute/client";
import type { ActorIdentifier } from "@atcute/lexicons/syntax";
import { getProfile, getProfiles, type ProfileView, type ProfileViewDetailed, rpc } from "../../shared/bsky";

export {
    type ActorIdentifier,
    getProfile,
    getProfiles,
    type ProfileView,
    type ProfileViewDetailed,
} from "../../shared/bsky";

export interface ProgressInfo {
    profile?: ProfileViewDetailed;
    followers?: number;
    follows?: number;
}

const paginate = async (
    endpoint: "app.bsky.graph.getFollowers" | "app.bsky.graph.getFollows",
    actor: ActorIdentifier,
    onProgress?: (info: { current: number; }) => void,
    signal?: AbortSignal,
): Promise<Map<string, ProfileView>> => {
    const all = new Map<string, ProfileView>();
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

export const getAllFollowers = (
    actor: ActorIdentifier,
    onProgress?: (info: { current: number; }) => void,
    signal?: AbortSignal,
) => paginate("app.bsky.graph.getFollowers", actor, onProgress, signal);

export const getAllFollows = (
    actor: ActorIdentifier,
    onProgress?: (info: { current: number; }) => void,
    signal?: AbortSignal,
) => paginate("app.bsky.graph.getFollows", actor, onProgress, signal);

export interface NetworkData {
    profile: ProfileViewDetailed;
    followers: Map<string, ProfileView>;
    follows: Map<string, ProfileView>;
}

export interface OverlapResult {
    profileA: ProfileViewDetailed;
    profileB: ProfileViewDetailed;
    sharedFollowers: ProfileView[];
    sharedFollows: ProfileView[];
    sharedMutuals: ProfileView[];
    onlyAFollows: ProfileView[];
    onlyBFollows: ProfileView[];
    followersA: number;
    followersB: number;
    followsA: number;
    followsB: number;
}

export const fetchNetworkData = async (
    actor: ActorIdentifier,
    onProgress?: (info: ProgressInfo) => void,
    preResolved?: ProfileViewDetailed,
    signal?: AbortSignal,
): Promise<NetworkData> => {
    const profile = preResolved ?? await getProfile(actor, signal);
    onProgress?.({ profile });
    const progress: ProgressInfo = { profile };
    const [followers, follows] = await Promise.all([
        getAllFollowers(actor, (info) => {
            progress.followers = info.current;
            onProgress?.({ ...progress });
        }, signal),
        getAllFollows(actor, (info) => {
            progress.follows = info.current;
            onProgress?.({ ...progress });
        }, signal),
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
        sharedFollowers,
        sharedFollows,
        sharedMutuals,
        onlyAFollows,
        onlyBFollows,
        followersA: a.followers.size,
        followersB: b.followers.size,
        followsA: a.follows.size,
        followsB: b.follows.size,
    };
};
