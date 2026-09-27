import type { ActorIdentifier } from "@atcute/lexicons/syntax";
import {
    getAllFollowers,
    getAllFollows,
    getProfile,
    getProfiles,
    getRelationships,
    type ProfileView,
    type ProfileViewDetailed,
} from "../../shared/bsky";

export {
    type ActorIdentifier,
    getAllFollowers,
    getAllFollows,
    getProfile,
    getProfiles,
    getRelationships,
    type ProfileView,
    type ProfileViewDetailed,
} from "../../shared/bsky";

export interface ProgressInfo {
    profile?: ProfileViewDetailed;
    followers?: number;
    follows?: number;
    relationships?: number;
}

export interface NetworkData {
    profile: ProfileViewDetailed;
    followers: Map<string, ProfileView>;
    followersCount: number;
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

export const fetchOverlapNetworkData = async (
    profileA: ProfileViewDetailed,
    profileB: ProfileViewDetailed,
    onProgressA?: (info: ProgressInfo) => void,
    onProgressB?: (info: ProgressInfo) => void,
    signal?: AbortSignal,
): Promise<[NetworkData, NetworkData]> => {
    const progressA: ProgressInfo = { profile: profileA };
    const progressB: ProgressInfo = { profile: profileB };
    const aHasFewerFollowers = (profileA.followersCount ?? Number.POSITIVE_INFINITY)
        <= (profileB.followersCount ?? Number.POSITIVE_INFINITY);
    const smallerProfile = aHasFewerFollowers ? profileA : profileB;
    const largerProfile = aHasFewerFollowers ? profileB : profileA;
    const smallerProgress = aHasFewerFollowers ? progressA : progressB;
    const largerProgress = aHasFewerFollowers ? progressB : progressA;
    const reportSmaller = aHasFewerFollowers ? onProgressA : onProgressB;
    const reportLarger = aHasFewerFollowers ? onProgressB : onProgressA;
    const estimatedCandidates = (smallerProfile.followersCount ?? Number.POSITIVE_INFINITY)
        + (profileA.followsCount ?? Number.POSITIVE_INFINITY)
        + (profileB.followsCount ?? Number.POSITIVE_INFINITY);
    const useRelationshipChecks = Math.ceil(estimatedCandidates / 30)
        < Math.ceil((largerProfile.followersCount ?? 0) / 100);

    if (!useRelationshipChecks) {
        const [followersA, followsA, followersB, followsB] = await Promise.all([
            getAllFollowers(profileA.did, (info) => {
                progressA.followers = info.current;
                onProgressA?.({ ...progressA });
            }, signal),
            getAllFollows(profileA.did, (info) => {
                progressA.follows = info.current;
                onProgressA?.({ ...progressA });
            }, signal),
            getAllFollowers(profileB.did, (info) => {
                progressB.followers = info.current;
                onProgressB?.({ ...progressB });
            }, signal),
            getAllFollows(profileB.did, (info) => {
                progressB.follows = info.current;
                onProgressB?.({ ...progressB });
            }, signal),
        ]);
        return [
            { profile: profileA, followers: followersA, followersCount: followersA.size, follows: followsA },
            { profile: profileB, followers: followersB, followersCount: followersB.size, follows: followsB },
        ];
    }

    const [followsA, followsB, smallerFollowers] = await Promise.all([
        getAllFollows(profileA.did, (info) => {
            progressA.follows = info.current;
            onProgressA?.({ ...progressA });
        }, signal),
        getAllFollows(profileB.did, (info) => {
            progressB.follows = info.current;
            onProgressB?.({ ...progressB });
        }, signal),
        getAllFollowers(smallerProfile.did, (info) => {
            smallerProgress.followers = info.current;
            reportSmaller?.({ ...smallerProgress });
        }, signal),
    ]);

    const candidateProfiles = new Map<string, ProfileView>([
        ...smallerFollowers,
        ...followsA,
        ...followsB,
    ]);
    const relationships = await getRelationships(
        largerProfile.did,
        [...candidateProfiles.keys()] as ActorIdentifier[],
        (info) => {
            largerProgress.relationships = info.current;
            reportLarger?.({ ...largerProgress });
        },
        signal,
    );
    const largerFollowers = new Map<string, ProfileView>();
    for (const relationship of relationships.values()) {
        if (relationship.followedBy === undefined) continue;
        const candidate = candidateProfiles.get(relationship.did);
        if (candidate) largerFollowers.set(relationship.did, candidate);
    }

    const smallerData = {
        profile: smallerProfile,
        followers: smallerFollowers,
        followersCount: smallerFollowers.size,
        follows: aHasFewerFollowers ? followsA : followsB,
    };
    const largerData = {
        profile: largerProfile,
        followers: largerFollowers,
        followersCount: largerProfile.followersCount ?? largerFollowers.size,
        follows: aHasFewerFollowers ? followsB : followsA,
    };
    return aHasFewerFollowers ? [smallerData, largerData] : [largerData, smallerData];
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
        followersA: a.followersCount,
        followersB: b.followersCount,
        followsA: a.follows.size,
        followsB: b.follows.size,
    };
};
