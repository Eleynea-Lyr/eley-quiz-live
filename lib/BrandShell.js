import WelcomeMark from "./WelcomeMark";
import PlayerScoreHelp from "./PlayerScoreHelp";
import { pageShellStyle } from "./brand-theme";
import { useRouter } from "next/router";

/** Fond violet → noir + logo bas droite (Player + Screen) */
export default function BrandShell({ children, style, scoreHelp, ...rest }) {
  const isFlexShell = style?.display === "flex";
  const router = useRouter();
  const showScoreHelp =
    scoreHelp === true ||
    (scoreHelp !== false && router?.pathname === "/player");

  return (
    <div
      style={{
        ...pageShellStyle,
        ...style,
        position: style?.position || "relative",
      }}
      {...rest}
    >
      <WelcomeMark />
      {showScoreHelp ? <PlayerScoreHelp /> : null}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          ...(isFlexShell
            ? {
                flex: 1,
                display: "flex",
                flexDirection: style?.flexDirection || "column",
                alignItems: style?.alignItems,
                justifyContent: style?.justifyContent,
                minHeight: 0,
              }
            : null),
        }}
      >
        {children}
      </div>
    </div>
  );
}
