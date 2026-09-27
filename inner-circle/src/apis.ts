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
    followers?: number;
    follows?: number;
    relationships?: number;
    mutuals?: number;
}

export interface MutualProfile extends ProfileViewDetailed {
    /** How many accounts this mutual follows */
    followsCount: number;
}

export async function fetchMutualsSorted(
    actor: ActorIdentifier,
    onProgress?: (info: ProgressInfo) => void,
    preResolved?: ProfileViewDetailed,
    signal?: AbortSignal,
): Promise<{ profile: ProfileViewDetailed; mutuals: MutualProfile[]; }> {
    const profile = preResolved ?? await getProfile(actor, signal);

    const progress: ProgressInfo = {};
    const reportFollows = (info: { current: number; }) => {
        progress.follows = info.current;
        onProgress?.({ ...progress });
    };
    const useRelationshipChecks = profile.followsCount != null
        && profile.followersCount != null
        && Math.ceil(profile.followsCount / 30) < Math.ceil(profile.followersCount / 100);

    let follows: Map<ActorIdentifier, ProfileView>;
    let mutualDids: ActorIdentifier[];
    if (useRelationshipChecks) {
        follows = await getAllFollows(actor, reportFollows, signal);
        const relationships = await getRelationships(
            profile.did,
            [...follows.keys()],
            (info) => {
                progress.relationships = info.current;
                onProgress?.({ ...progress });
            },
            signal,
        );
        mutualDids = [...relationships.values()]
            .filter((relationship) => relationship.followedBy !== undefined)
            .map((relationship) => relationship.did);
    } else {
        const [allFollows, followers] = await Promise.all([
            getAllFollows(actor, reportFollows, signal),
            getAllFollowers(actor, (info) => {
                progress.followers = info.current;
                onProgress?.({ ...progress });
            }, signal),
        ]);
        follows = allFollows;
        mutualDids = [];
        for (const did of follows.keys()) {
            if (followers.has(did)) {
                mutualDids.push(did);
            }
        }
    }

    if (follows.size === 0) {
        mutualDids = [];
    }
    onProgress?.({ ...progress, mutuals: mutualDids.length });

    // Enrich with full profiles to get followsCount
    const fullProfiles = mutualDids.length > 0
        ? await getProfiles(mutualDids, signal)
        : new Map<ActorIdentifier, ProfileViewDetailed>();

    const mutuals: MutualProfile[] = [];
    for (const did of mutualDids) {
        const full = fullProfiles.get(did);
        if (!full) continue;
        mutuals.push({
            ...full,
            followsCount: full.followsCount ?? 0,
        });
    }

    // Sort by followsCount ascending — fewer follows = you're more important to them
    // Tie-break by follower count descending — more followers first
    mutuals.sort((a, b) => a.followsCount - b.followsCount || (b.followersCount ?? 0) - (a.followersCount ?? 0));

    return { profile, mutuals };
}
