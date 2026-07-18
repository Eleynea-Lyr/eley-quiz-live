import WelcomeMark from "./WelcomeMark";
import { pageShellStyle } from "./brand-theme";

/** Fond violet → noir + logo bas droite (Player + Screen) */
export default function BrandShell({ children, style, ...rest }) {
  const isFlexShell = style?.display === "flex";

  return (
    <div
      style={{
        ...pageShellStyle,
        ...style,
      }}
      {...rest}
    >
      <WelcomeMark />
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
