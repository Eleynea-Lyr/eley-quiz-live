// Filigrane — logo PNG bas droite (Player + Screen)

export default function WelcomeMark() {  return (
    <img
      src="/graphics/eley-logo-mark.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{
        position: "absolute",
        right: "max(14px, env(safe-area-inset-right, 0px))",
        bottom: "max(14px, env(safe-area-inset-bottom, 0px))",
        width: "min(28vw, 128px)",
        height: "auto",
        pointerEvents: "none",
        zIndex: 0,
        opacity: 0.48,
      }}
    />
  );
}
