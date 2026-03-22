import { ok } from "@atcute/client";
import type { ActorIdentifier } from "@atcute/lexicons/syntax";
import { getProfiles, type ProfileView, type ProfileViewDetailed, rpc } from "../../shared/bsky";

export {
    type ActorIdentifier,
    getProfile,
    getProfiles,
    type ProfileView,
    type ProfileViewDetailed,
} from "../../shared/bsky";

export interface ProgressInfo {
    follows?: number;
    mutuals?: number;
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
    const { getProfile } = await import("../../shared/bsky");
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
        : new Map<string, ProfileViewDetailed>();

    const mutuals: MutualProfile[] = mutualDids.map((did) => {
        const full = fullProfiles.get(did) ?? follows.get(did) as ProfileViewDetailed;
        return {
            ...full,
            followsCount: full.followsCount ?? 0,
        };
    });

    // Sort by followsCount ascending — fewer follows = you're more important to them
    // Tie-break by follower count descending — more followers first
    mutuals.sort((a, b) => a.followsCount - b.followsCount || (b.followersCount ?? 0) - (a.followersCount ?? 0));

    return { profile, mutuals };
}
