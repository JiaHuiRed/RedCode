import { type ComponentProps } from "solid-js"

/** RedCode mark: simplified Mangekyou Sharingan eye */
export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Outer ring */}
      <circle cx="10" cy="10" r="9.5" stroke="var(--icon-strong-base)" stroke-width="1" />
      {/* Three rotating blades at 0°, 120°, 240° */}
      <path
        d="M10,10 C11,8 14,5 10,2 C6,5 9,8 10,10Z"
        fill="var(--icon-strong-base)"
      />
      <path
        d="M10,10 C11,8 14,5 10,2 C6,5 9,8 10,10Z"
        fill="var(--icon-weak-base)"
        transform="rotate(120,10,10)"
      />
      <path
        d="M10,10 C11,8 14,5 10,2 C6,5 9,8 10,10Z"
        fill="var(--icon-strong-base)"
        transform="rotate(240,10,10)"
      />
      {/* Center pupil */}
      <circle cx="10" cy="10" r="1.8" fill="var(--icon-strong-base)" />
    </svg>
  )
}

/** RedCode splash screen: animated Mangekyou eye */
export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <style>{`
        @keyframes rc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes rc-pulse { 0%,100% { opacity:0.7; } 50% { opacity:1; } }
        .rc-spin { transform-origin: 40px 40px; animation: rc-spin 3s linear infinite; }
        .rc-pulse { animation: rc-pulse 2s ease-in-out infinite; }
      `}</style>
      {/* Outer ring */}
      <circle cx="40" cy="40" r="37" stroke="currentColor" stroke-width="2" opacity="0.6" class="rc-pulse" />
      {/* Three blades - spinning */}
      <g class="rc-spin">
        <path d="M40,40 C43,32 52,20 40,10 C28,20 37,32 40,40Z" fill="currentColor" />
        <path
          d="M40,40 C43,32 52,20 40,10 C28,20 37,32 40,40Z"
          fill="currentColor"
          opacity="0.7"
          transform="rotate(120,40,40)"
        />
        <path
          d="M40,40 C43,32 52,20 40,10 C28,20 37,32 40,40Z"
          fill="currentColor"
          transform="rotate(240,40,40)"
        />
      </g>
      {/* Center pupil */}
      <circle cx="40" cy="40" r="7" fill="currentColor" class="rc-pulse" />
    </svg>
  )
}

/** RedCode wordmark */
export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 204 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        {/* R */}
        <path d="M18 18H6V6H18V18Z" fill="var(--icon-weak-base)" />
        <path d="M18 6H6V36H12V24H15L20 36H26L20 22C22 20 24 18 24 14C24 9 21 6 18 6ZM12 18V12H17C19 12 18 18 17 18Z" fill="var(--icon-strong-base)" />
        {/* E */}
        <path d="M54 24V30H36V24H54Z" fill="var(--icon-weak-base)" />
        <path d="M54 24H36V30H54V36H30V6H54V12H36V18H50V24Z" fill="var(--icon-strong-base)" />
        {/* D */}
        <path d="M78 30H66V18H78V30Z" fill="var(--icon-weak-base)" />
        <path d="M78 6H60V36H78C84 36 90 30 90 21C90 12 84 6 78 6ZM78 30H66V12H78C81 12 84 16 84 21C84 26 81 30 78 30Z" fill="var(--icon-strong-base)" />
        {/* C */}
        <path d="M114 30H96V18H114V30Z" fill="var(--icon-weak-base)" />
        <path d="M114 12H96V30H114V36H90V6H114V12Z" fill="var(--icon-strong-base)" />
        {/* O */}
        <path d="M138 30H126V18H138V30Z" fill="var(--icon-weak-base)" />
        <path d="M138 12H126V30H138V12ZM144 36H120V6H144V36Z" fill="var(--icon-strong-base)" />
        {/* D */}
        <path d="M168 30H156V18H168V30Z" fill="var(--icon-weak-base)" />
        <path d="M168 6H150V36H168C174 36 180 30 180 21C180 12 174 6 168 6ZM168 30H156V12H168C171 12 174 16 174 21C174 26 171 30 168 30Z" fill="var(--icon-strong-base)" />
        {/* E */}
        <path d="M204 24V30H186V24H204Z" fill="var(--icon-weak-base)" />
        <path d="M204 24H186V30H204V36H180V6H204V12H186V18H200V24Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
