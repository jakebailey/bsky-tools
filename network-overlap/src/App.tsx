import "water.css/out/dark.min.css";
import "../../shared.css";
import "./App.css";

import { makePersisted } from "@solid-primitives/storage";
import { HashRouter, Route, useNavigate, useParams } from "@solidjs/router";
import { type Component, createEffect, createSignal, For, Match, Show, Switch } from "solid-js";
import { cleanHandle, isEngagementHacker, profilePrefix } from "../../shared/bsky";
import { ProfileCard } from "../../shared/ProfileCard";
import {
    type ActorIdentifier,
    computeOverlap,
    fetchNetworkData,
    getProfile,
    getProfiles,
    type OverlapResult,
    type ProfileView,
    type ProfileViewDetailed,
    type ProgressInfo,
} from "./apis";

type EnrichedOverlapResult =
    & Omit<OverlapResult, "sharedFollowers" | "sharedFollows" | "sharedMutuals" | "onlyAFollows" | "onlyBFollows">
    & {
        sharedFollowers: ProfileViewDetailed[];
        sharedFollows: ProfileViewDetailed[];
        sharedMutuals: ProfileViewDetailed[];
        onlyAFollows: ProfileViewDetailed[];
        onlyBFollows: ProfileViewDetailed[];
    };

const ProfileListItem: Component<{ profile: ProfileViewDetailed; dimHackers: boolean; }> = (props) => (
    <li class="profile-item" classList={{ "engagement-hacker": props.dimHackers && isEngagementHacker(props.profile) }}>
        <Show when={props.profile.avatar}>
            <img
                src={props.profile.avatar!}
                alt=""
                class="avatar-small"
            />
        </Show>
        <div>
            <a href={`${profilePrefix}${props.profile.handle}`}>
                {props.profile.displayName || props.profile.handle}
            </a>{" "}
            <span class="handle">@{props.profile.handle}</span>
            <Show when={props.profile.followersCount != null}>
                {" "}
                <span class="follower-count">
                    ({props.profile.followersCount!.toLocaleString()} followers,{" "}
                    {props.profile.followsCount!.toLocaleString()} following)
                </span>
            </Show>
            <Show when={isEngagementHacker(props.profile)}>
                {" "}
                <span class="hacker-badge" title="Suspected engagement hacker (following 10k+ with high follow ratio)">
                    ⚠️
                </span>
            </Show>
        </div>
    </li>
);

const OverlapSection: Component<{
    title: string;
    description: string;
    profiles: ProfileViewDetailed[];
    countA: number;
    countB: number;
    collapsed?: boolean;
    dimHackers: boolean;
}> = (props) => {
    const [expanded, setExpanded] = createSignal(!props.collapsed);
    const [showAll, setShowAll] = createSignal(false);
    const displayed = () => showAll() ? props.profiles : props.profiles.slice(0, 50);
    const pctSmaller = () => {
        const smaller = Math.min(props.countA, props.countB);
        return smaller > 0 ? (props.profiles.length / smaller * 100).toFixed(1) : "0";
    };

    return (
        <div class="overlap-section">
            <h2
                class="section-header"
                onClick={() => setExpanded(!expanded())}
            >
                <span class="toggle">{expanded() ? "▾" : "▸"}</span>
                {props.title} ({props.profiles.length})
                <span class="pct">— {pctSmaller()}% overlap</span>
            </h2>
            <Show when={expanded()}>
                <p class="section-desc">{props.description}</p>
                <ul class="profile-list">
                    <For each={displayed()}>
                        {(profile) => <ProfileListItem profile={profile} dimHackers={props.dimHackers} />}
                    </For>
                </ul>
                <Show when={props.profiles.length > 50 && !showAll()}>
                    <button onClick={() => setShowAll(true)}>
                        Show all {props.profiles.length}
                    </button>
                </Show>
            </Show>
        </div>
    );
};

type CompareState =
    | { status: "idle"; }
    | {
        status: "loading";
        progressA: ProgressInfo | null;
        progressB: ProgressInfo | null;
        profileA: ProfileViewDetailed | null;
        profileB: ProfileViewDetailed | null;
    }
    | { status: "enriching"; profileA: ProfileViewDetailed; profileB: ProfileViewDetailed; }
    | { status: "done"; result: EnrichedOverlapResult; }
    | { status: "error"; error: string; }
    | { status: "self-compare"; profile: ProfileViewDetailed; };

const Page: Component = () => {
    const navigate = useNavigate();
    const params = useParams<{ handleA?: string; handleB?: string; }>();
    const [state, setState] = createSignal<CompareState>({ status: "idle" });
    let abortController: AbortController | undefined;
    const [dimHackers, setDimHackers] = makePersisted(createSignal(true), { name: "dimHackers" });

    const doCompare = async (handleA: ActorIdentifier, handleB: ActorIdentifier) => {
        abortController?.abort();
        const controller = new AbortController();
        abortController = controller;
        const signal = controller.signal;
        setState({ status: "loading", progressA: null, progressB: null, profileA: null, profileB: null });

        try {
            // Resolve profiles first to detect self-comparison before expensive network fetches
            const [profileA, profileB] = await Promise.all([getProfile(handleA, signal), getProfile(handleB, signal)]);

            if (signal.aborted) return;

            if (profileA.did === profileB.did) {
                setState({ status: "self-compare", profile: profileA });
                return;
            }

            setState((prev) => {
                if (prev.status !== "loading") return prev;
                return { ...prev, profileA, profileB } as CompareState & { status: "loading"; };
            });

            const [dataA, dataB] = await Promise.all([
                fetchNetworkData(
                    handleA,
                    (info) => {
                        if (signal.aborted) return;
                        setState((prev) => {
                            if (prev.status !== "loading") return prev;
                            return { ...prev, progressA: info } as CompareState & {
                                status: "loading";
                            };
                        });
                    },
                    profileA,
                    signal,
                ),
                fetchNetworkData(
                    handleB,
                    (info) => {
                        if (signal.aborted) return;
                        setState((prev) => {
                            if (prev.status !== "loading") return prev;
                            return { ...prev, progressB: info } as CompareState & {
                                status: "loading";
                            };
                        });
                    },
                    profileB,
                    signal,
                ),
            ]);

            if (signal.aborted) return;

            setState({ status: "enriching", profileA: dataA.profile, profileB: dataB.profile });

            const result = computeOverlap(dataA, dataB);

            // Batch-fetch full profiles for shared users to get follower counts
            const allDids = new Set([
                ...result.sharedFollowers.map((p) => p.did),
                ...result.sharedFollows.map((p) => p.did),
                ...result.sharedMutuals.map((p) => p.did),
                ...result.onlyAFollows.map((p) => p.did),
                ...result.onlyBFollows.map((p) => p.did),
            ]);
            const fullProfiles = allDids.size > 0
                ? await getProfiles([...allDids], signal)
                : new Map<string, ProfileViewDetailed>();
            const enrich = (profiles: ProfileView[]): ProfileViewDetailed[] =>
                profiles.map((p) => fullProfiles.get(p.did) ?? (p as ProfileViewDetailed));

            const enrichedResult: EnrichedOverlapResult = {
                ...result,
                sharedFollowers: enrich(result.sharedFollowers),
                sharedFollows: enrich(result.sharedFollows),
                sharedMutuals: enrich(result.sharedMutuals),
                onlyAFollows: enrich(result.onlyAFollows),
                onlyBFollows: enrich(result.onlyBFollows),
            };

            // Sort by follower count descending
            const byFollowers = (a: ProfileViewDetailed, b: ProfileViewDetailed) =>
                (b.followersCount ?? 0) - (a.followersCount ?? 0);
            enrichedResult.sharedFollowers.sort(byFollowers);
            enrichedResult.sharedFollows.sort(byFollowers);
            enrichedResult.sharedMutuals.sort(byFollowers);
            enrichedResult.onlyAFollows.sort(byFollowers);
            enrichedResult.onlyBFollows.sort(byFollowers);

            setState({ status: "done", result: enrichedResult });
        } catch (e) {
            if (signal.aborted) return;
            setState({ status: "error", error: String(e) });
        }
    };

    // React to URL changes (back/forward navigation, initial load, form submit)
    createEffect(() => {
        const a = params.handleA;
        const b = params.handleB;
        if (a && b) {
            try {
                const actorA = cleanHandle(decodeURIComponent(a));
                const actorB = cleanHandle(decodeURIComponent(b));
                if (actorA !== decodeURIComponent(a) || actorB !== decodeURIComponent(b)) {
                    navigate(`/${encodeURIComponent(actorA)}/${encodeURIComponent(actorB)}`, { replace: true });
                    return;
                }
                doCompare(actorA, actorB);
            } catch (err) {
                setState({ status: "error", error: err instanceof Error ? err.message : "Invalid handle" });
            }
        } else {
            setState({ status: "idle" });
        }
    });

    const formatProgress = (info: ProgressInfo | null, handle: string) => {
        if (!info) return `${handle}: resolving...`;
        if (info.followers == null && info.follows == null) return `${handle}: fetching network...`;
        const parts = [];
        if (info.followers != null) parts.push(`${info.followers.toLocaleString()} followers`);
        if (info.follows != null) parts.push(`${info.follows.toLocaleString()} following`);
        return `${handle}: ${parts.join(", ")}`;
    };

    return (
        <div>
            <a href=".." class="back-link" rel="external">← Bluesky Tools</a>
            <h1>Bluesky Network Overlap</h1>
            <p class="subtitle">Compare the followers and follows of two Bluesky users</p>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    try {
                        const form = e.target as HTMLFormElement;
                        const a = cleanHandle(form.handleA.value);
                        const b = cleanHandle(form.handleB.value);
                        if (!a || !b) return;
                        setState({ status: "idle" });
                        navigate(`/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
                    } catch (err) {
                        setState({ status: "error", error: err instanceof Error ? err.message : "Invalid handle" });
                    }
                }}
            >
                <div class="input-row">
                    <input
                        id="handleA"
                        name="handleA"
                        type="text"
                        placeholder="First handle, DID, or profile link"
                        value={decodeURIComponent(params.handleA || "")}
                        autofocus
                    />
                    <span class="vs">vs</span>
                    <input
                        id="handleB"
                        name="handleB"
                        type="text"
                        placeholder="Second handle, DID, or profile link"
                        value={decodeURIComponent(params.handleB || "")}
                    />
                    <button type="submit">Compare</button>
                </div>
            </form>

            <Switch>
                <Match when={state().status === "loading"}>
                    {(() => {
                        const s = state() as CompareState & { status: "loading"; };
                        return (
                            <>
                                <Show when={s.profileA || s.profileB}>
                                    <div class="profiles-row">
                                        <Show when={s.profileA} fallback={<blockquote class="profile-placeholder" />}>
                                            <ProfileCard profile={s.profileA!} />
                                        </Show>
                                        <Show when={s.profileB} fallback={<blockquote class="profile-placeholder" />}>
                                            <ProfileCard profile={s.profileB!} />
                                        </Show>
                                    </div>
                                </Show>
                                <div class="loading">
                                    <p>Fetching network data...</p>
                                    <p class="progress">
                                        {formatProgress(s.progressA, decodeURIComponent(params.handleA || "User A"))}
                                    </p>
                                    <p class="progress">
                                        {formatProgress(s.progressB, decodeURIComponent(params.handleB || "User B"))}
                                    </p>
                                    <p class="note">This may take a while for accounts with many followers.</p>
                                </div>
                            </>
                        );
                    })()}
                </Match>
                <Match when={state().status === "enriching"}>
                    {(() => {
                        const s = state() as CompareState & { status: "enriching"; };
                        return (
                            <>
                                <div class="profiles-row">
                                    <ProfileCard profile={s.profileA} />
                                    <ProfileCard profile={s.profileB} />
                                </div>
                                <div class="loading">
                                    <p>Computing overlap and fetching profile details...</p>
                                </div>
                            </>
                        );
                    })()}
                </Match>
                <Match when={state().status === "error"}>
                    <p class="error">Error: {(state() as CompareState & { status: "error"; }).error}</p>
                </Match>
                <Match when={state().status === "self-compare"}>
                    {(() => {
                        const s = state() as CompareState & { status: "self-compare"; };
                        return (
                            <>
                                <div class="profiles-row">
                                    <ProfileCard profile={s.profile} />
                                    <ProfileCard profile={s.profile} />
                                </div>
                                <div class="loading">
                                    <p>That's the same person. 100% overlap. Shocking. 🎉</p>
                                </div>
                            </>
                        );
                    })()}
                </Match>
                <Match when={state().status === "done"}>
                    {(() => {
                        const result = () => (state() as CompareState & { status: "done"; }).result;
                        return (
                            <>
                                <div class="profiles-row">
                                    <ProfileCard profile={result().profileA} />
                                    <ProfileCard profile={result().profileB} />
                                </div>

                                <div class="summary">
                                    <h2>Summary</h2>
                                    <table>
                                        <thead>
                                            <tr>
                                                <th></th>
                                                <th>@{result().profileA.handle}</th>
                                                <th>@{result().profileB.handle}</th>
                                                <th>Shared</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr>
                                                <td>Followers</td>
                                                <td>{result().followersA.toLocaleString()}</td>
                                                <td>{result().followersB.toLocaleString()}</td>
                                                <td>{result().sharedFollowers.length.toLocaleString()}</td>
                                            </tr>
                                            <tr>
                                                <td>Following</td>
                                                <td>{result().followsA.toLocaleString()}</td>
                                                <td>{result().followsB.toLocaleString()}</td>
                                                <td>{result().sharedFollows.length.toLocaleString()}</td>
                                            </tr>
                                            <tr>
                                                <td>Mutuals</td>
                                                <td></td>
                                                <td></td>
                                                <td>{result().sharedMutuals.length.toLocaleString()}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>

                                <label class="dim-toggle">
                                    <input
                                        type="checkbox"
                                        checked={dimHackers()}
                                        onChange={(e) => setDimHackers(e.currentTarget.checked)}
                                    />{" "}
                                    Dim suspected engagement hackers
                                </label>

                                <OverlapSection
                                    title="Shared Mutuals"
                                    description={`People both @${result().profileA.handle} and @${result().profileB.handle} follow and are followed by`}
                                    profiles={result().sharedMutuals}
                                    countA={result().followsA}
                                    countB={result().followsB}
                                    dimHackers={dimHackers()}
                                />

                                <OverlapSection
                                    title="Shared Follows"
                                    description={`People both @${result().profileA.handle} and @${result().profileB.handle} follow`}
                                    profiles={result().sharedFollows}
                                    countA={result().followsA}
                                    countB={result().followsB}
                                    dimHackers={dimHackers()}
                                />

                                <OverlapSection
                                    title="Shared Followers"
                                    description={`People who follow both @${result().profileA.handle} and @${result().profileB.handle}`}
                                    profiles={result().sharedFollowers}
                                    countA={result().followersA}
                                    countB={result().followersB}
                                    dimHackers={dimHackers()}
                                />

                                <OverlapSection
                                    title={`Only @${result().profileA.handle} follows`}
                                    description={`People @${result().profileA.handle} follows but @${result().profileB.handle} doesn't`}
                                    profiles={result().onlyAFollows}
                                    countA={result().followsA}
                                    countB={result().followsB}
                                    collapsed
                                    dimHackers={dimHackers()}
                                />

                                <OverlapSection
                                    title={`Only @${result().profileB.handle} follows`}
                                    description={`People @${result().profileB.handle} follows but @${result().profileA.handle} doesn't`}
                                    profiles={result().onlyBFollows}
                                    countA={result().followsA}
                                    countB={result().followsB}
                                    collapsed
                                    dimHackers={dimHackers()}
                                />
                            </>
                        );
                    })()}
                </Match>
            </Switch>

            <p class="footer">
                This site queries the Bluesky API directly in your browser. No data is stored.
            </p>
        </div>
    );
};

const App: Component = () => {
    return (
        <HashRouter root={(props) => <>{props.children}</>}>
            <Route path="/:handleA?/:handleB?" component={Page} />
        </HashRouter>
    );
};

export default App;
