import { type Component, Show } from "solid-js";
import { profilePrefix, type ProfileViewDetailed } from "./bsky";
import { RichText } from "./RichText";

export const ProfileCard: Component<{ profile: ProfileViewDetailed; }> = (props) => (
    <blockquote>
        <p>
            <Show when={props.profile.avatar}>
                {(avatar) => (
                    <img
                        src={avatar()}
                        alt=""
                        style={{
                            width: "24px",
                            height: "24px",
                            "border-radius": "50%",
                            "vertical-align": "middle",
                            "margin-right": "6px",
                        }}
                    />
                )}
            </Show>
            <a href={`${profilePrefix}${props.profile.handle}`}>
                {props.profile.displayName || props.profile.handle}
            </a>{" "}
            <span class="handle">@{props.profile.handle}</span>
        </p>
        <Show when={props.profile.description}>
            {(description) => (
                <p class="description">
                    <RichText text={description()} />
                </p>
            )}
        </Show>
        <p class="stats">
            <Show when={props.profile.followersCount != null}>
                <span>{props.profile.followersCount!.toLocaleString()} followers</span>
                {" · "}
            </Show>
            <Show when={props.profile.followsCount != null}>
                <span>{props.profile.followsCount!.toLocaleString()} following</span>
            </Show>
        </p>
    </blockquote>
);
