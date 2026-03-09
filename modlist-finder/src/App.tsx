import "water.css/out/dark.min.css";
import "../../shared.css";
import "./App.css";

import { makePersisted } from "@solid-primitives/storage";
import { HashRouter, Route, useNavigate, useParams } from "@solidjs/router";
import { type Component, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { isEngagementHacker, profilePrefix } from "../../shared/bsky";
import { ProfileCard } from "../../shared/ProfileCard";
import { RichText } from "../../shared/RichText";
import { getBlueskyListPurpose, getClearskyLists, getProfile, getProfiles, type ProfileViewDetailed } from "./apis";

async function doWork(queryHandle: string) {
    const profile = await getProfile(queryHandle);
    const clearskyLists = await getClearskyLists(queryHandle);

    // Fetch list purposes concurrently, ignoring failures
    const results = await Promise.allSettled(
        clearskyLists.map(async (list) => {
            const purpose = await getBlueskyListPurpose(list.did, list.url);
            return { list, purpose };
        }),
    );

    const modClearskyLists = results
        .filter((r): r is PromiseFulfilledResult<{ list: typeof clearskyLists[number]; purpose: string; }> =>
            r.status === "fulfilled" && r.value.purpose === "app.bsky.graph.defs#modlist"
        )
        .map((r) => r.value.list);

    let profiles: Map<string, ProfileViewDetailed> | undefined;
    try {
        profiles = await getProfiles(modClearskyLists.map((list) => list.did));
    } catch {
        // ignore
    }

    if (!profiles?.size) {
        return { profile, lists: [] };
    }

    const lists = [];
    for (const list of modClearskyLists) {
        const listProfile = profiles.get(list.did);
        if (!listProfile || listProfile.handle === "handle.invalid") {
            continue;
        }
        lists.push({ profile: listProfile, list });
    }

    // sort descending by followers count
    lists.sort((a, b) => (b.profile.followersCount ?? 0) - (a.profile.followersCount ?? 0));

    return { profile, lists };
}

const Page: Component = () => {
    const navigate = useNavigate();
    const params = useParams<{ handle?: string | undefined; }>();
    const [info] = createResource(() => params.handle || undefined, doWork);
    const [dimHackers, setDimHackers] = makePersisted(createSignal(true), { name: "dimHackers" });
    return (
        <div>
            <a href=".." class="back-link" rel="external">← Bluesky Tools</a>
            <h1>Bluesky Moderation List Finder</h1>
            <br />
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    const value = (e.target as HTMLFormElement).handle.value.trim();
                    if (!value) return;
                    navigate(`/${encodeURIComponent(value)}`);
                }}
            >
                <input
                    id="handle"
                    type="text"
                    placeholder="Enter handle, DID, or profile link"
                    value={decodeURIComponent(params.handle || "")}
                    autofocus
                />
                <button type="submit">Search</button>
            </form>

            <Show when={info.state === "ready"}>
                <ProfileCard profile={info()!.profile} />
            </Show>

            <Switch>
                <Match when={info.loading}>
                    <p>Loading...</p>
                </Match>
                <Match when={info.error}>
                    <span>Error: {`${info.error}`}</span>
                </Match>
                <Match when={info()}>
                    <label class="dim-toggle">
                        <input
                            type="checkbox"
                            checked={dimHackers()}
                            onChange={(e) => setDimHackers(e.currentTarget.checked)}
                        />{" "}
                        Dim suspected engagement hackers
                    </label>
                    <p>{info()!.lists.length} moderation lists</p>
                    <ul class="profile-list">
                        <For each={info()!.lists}>
                            {(list) => (
                                <li
                                    class="profile-item"
                                    classList={{
                                        "engagement-hacker": dimHackers() && isEngagementHacker(list.profile),
                                    }}
                                >
                                    <Show when={list.profile.avatar}>
                                        <img
                                            src={list.profile.avatar!}
                                            alt=""
                                            class="avatar-small"
                                        />
                                    </Show>
                                    <div>
                                        <a href={list.list.url}>{list.list.name}</a> by{" "}
                                        <a href={`${profilePrefix}${list.profile.handle}`}>
                                            {list.profile.handle}
                                        </a>{" "}
                                        <span class="follower-count">
                                            ({list.profile.followersCount} followers)
                                        </span>
                                        <Show when={isEngagementHacker(list.profile)}>
                                            {" "}
                                            <span
                                                class="hacker-badge"
                                                title="Suspected engagement hacker (following 10k+ with high follow ratio)"
                                            >
                                                ⚠️
                                            </span>
                                        </Show>
                                        <Show when={list.list.description}>
                                            <p>
                                                <RichText text={list.list.description!} />
                                            </p>
                                        </Show>
                                    </div>
                                </li>
                            )}
                        </For>
                    </ul>
                </Match>
            </Switch>

            <p class="footer">
                This site queries the Bluesky and Clearsky APIs directly in your browser. No data is stored. Note that
                all content is generated from those APIs; I can't be responsible for anything that shows up here, and
                list creator follower count is not necessarily a good measure of quality or trustworthiness. Use these
                lists at your own risk.
            </p>
        </div>
    );
};

const App: Component = () => {
    return (
        <HashRouter root={(props) => <>{props.children}</>}>
            <Route path="/:handle?" component={Page} />
        </HashRouter>
    );
};

export default App;
