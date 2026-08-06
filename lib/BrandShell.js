import WelcomeMark from "./WelcomeMark";
import dynamic from "next/dynamic";
import { pageShellStyle } from "./brand-theme";

// Client-only : évite tout souci d’hydratation / crash qui laisserait l’écran noir
const PlayerScoreHelp = dynamic(() => import("./PlayerScoreHelp"), {
  ssr: false,
  loading: () => null,
});

/** Fond violet → noir + logo bas droite (Player + Screen) */
export default function BrandShell({ children, style, scoreHelp = false, ...rest }) {
  const isFlexShell = style?.display === "flex";

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
      {scoreHelp ? <PlayerScoreHelp /> : null}
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
