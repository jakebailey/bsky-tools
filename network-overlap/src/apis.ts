import type { ActorIdentifier } from "@atcute/lexicons/syntax";
import {
    getAllFollowers,
    getAllFollows,
    getProfile,
    getProfiles,
    type ProfileView,
    type ProfileViewDetailed,
} from "../../shared/bsky";

export {
    type ActorIdentifier,
    getAllFollowers,
    getAllFollows,
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
    missingMutualsA: ProfileView[];
    missingMutualsB: ProfileView[];
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

    // Missing mutuals for A: people B follows who follow A, but A doesn't follow back
    const missingMutualsADids: string[] = [];
    for (const did of b.follows.keys()) {
        if (a.followers.has(did) && !a.follows.has(did)) {
            missingMutualsADids.push(did);
        }
    }

    // Missing mutuals for B: people A follows who follow B, but B doesn't follow back
    const missingMutualsBDids: string[] = [];
    for (const did of a.follows.keys()) {
        if (b.followers.has(did) && !b.follows.has(did)) {
            missingMutualsBDids.push(did);
        }
    }

    const sharedFollowers = sharedFollowerDids.map((did) => pickProfile(did, a.followers, b.followers));
    const sharedFollows = sharedFollowDids.map((did) => pickProfile(did, a.follows, b.follows));
    const sharedMutuals = sharedMutualDids.map((did) => pickProfile(did, a.follows, b.follows));
    const onlyAFollows = onlyAFollowDids.map((did) => a.follows.get(did)!);
    const onlyBFollows = onlyBFollowDids.map((did) => b.follows.get(did)!);
    const missingMutualsA = missingMutualsADids.map((did) => pickProfile(did, b.follows, a.followers));
    const missingMutualsB = missingMutualsBDids.map((did) => pickProfile(did, a.follows, b.followers));

    return {
        profileA: a.profile,
        profileB: b.profile,
        sharedFollowers,
        sharedFollows,
        sharedMutuals,
        onlyAFollows,
        onlyBFollows,
        missingMutualsA,
        missingMutualsB,
        followersA: a.followers.size,
        followersB: b.followers.size,
        followsA: a.follows.size,
        followsB: b.follows.size,
    };
};
