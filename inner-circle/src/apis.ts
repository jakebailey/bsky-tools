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
    follows?: number;
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

    // Fetch follows and followers in parallel
    const progress: ProgressInfo = {};
    const [follows, followers] = await Promise.all([
        getAllFollows(actor, (info) => {
            progress.follows = info.current;
            onProgress?.({ ...progress });
        }, signal),
        getAllFollowers(actor, (info) => {
            // We track followers progress but show follows in UI
            onProgress?.({ ...progress });
        }, signal),
    ]);

    // Find mutuals: people you follow who also follow you back
    const mutualDids: ActorIdentifier[] = [];
    for (const did of follows.keys()) {
        if (followers.has(did)) {
            mutualDids.push(did);
        }
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
