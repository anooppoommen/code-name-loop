import {
  animate,
  AnimatePresence,
  motion,
  useReducedMotion,
} from "framer-motion";
import type { HTMLMotionProps, Transition } from "framer-motion";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export const ACTIVITY_EASE = [0.22, 1, 0.36, 1] as const;
export const ACTIVITY_EASE_CSS = "cubic-bezier(0.22, 1, 0.36, 1)";
export const ACTIVITY_STREAM_RENDER_THROTTLE_MS = 100;

export const GROW_SPRING = {
  type: "spring",
  visualDuration: 0.5,
  bounce: 0,
} as const;
export const COLLAPSIBLE_SPRING = {
  type: "spring",
  visualDuration: 0.3,
  bounce: 0,
} as const;
export const FAST_SPRING = {
  type: "spring",
  visualDuration: 0.35,
  bounce: 0,
} as const;

export const ACTIVITY_TRANSITIONS = {
  entry: FAST_SPRING,
  reveal: { ...FAST_SPRING, visualDuration: 0.25 },
  panel: COLLAPSIBLE_SPRING,
  collapse: COLLAPSIBLE_SPRING,
  emphasis: FAST_SPRING,
  grow: GROW_SPRING,
} as const satisfies Record<string, Transition>;

type MotionOpts = {
  distance?: number;
  exitDistance?: number;
  blur?: number;
  exitBlur?: number;
  scale?: number;
  exitScale?: number;
  transition?: Transition;
  disableInitialAnimation?: boolean;
};

type HoverOpts = {
  x?: number;
  exitX?: number;
  y?: number;
  exitY?: number;
  blur?: number;
  exitBlur?: number;
  scale?: number;
  exitScale?: number;
  transition?: Transition;
};

const still = { initial: false as const };

export function entryMotion(enabled: boolean, opts: MotionOpts = {}) {
  if (!enabled) {
    return still;
  }

  const distance = opts.distance ?? 12;
  const exitDistance = opts.exitDistance ?? -8;
  const initial = opts.disableInitialAnimation
    ? false
    : { opacity: 0, y: distance };

  return {
    initial,
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: exitDistance },
    transition: opts.transition ?? ACTIVITY_TRANSITIONS.entry,
  };
}

export function revealMotion(enabled: boolean, opts: MotionOpts = {}) {
  if (!enabled) {
    return still;
  }

  const distance = opts.distance ?? 8;
  const exitDistance = opts.exitDistance ?? -4;
  const initial = opts.disableInitialAnimation
    ? false
    : { opacity: 0, y: distance };

  return {
    initial,
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: exitDistance },
    transition: opts.transition ?? ACTIVITY_TRANSITIONS.reveal,
  };
}

export function popoverMotion(enabled: boolean, opts: MotionOpts = {}) {
  if (!enabled) {
    return still;
  }

  const distance = opts.distance ?? 4;
  const exitDistance = opts.exitDistance ?? 2;

  return {
    initial: { opacity: 0, y: distance },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: exitDistance },
    transition: opts.transition ?? ACTIVITY_TRANSITIONS.panel,
  };
}

export function hoverMotion(enabled: boolean, opts: HoverOpts = {}) {
  if (!enabled) {
    return still;
  }

  const x = opts.x ?? 6;
  const exitX = opts.exitX ?? x;
  const y = opts.y ?? 0;
  const exitY = opts.exitY ?? y;

  return {
    initial: { opacity: 0, x, y },
    animate: { opacity: 1, x: 0, y: 0 },
    exit: { opacity: 0, x: exitX, y: exitY },
    transition: opts.transition ?? ACTIVITY_TRANSITIONS.panel,
  };
}

export function useThrottledText(
  value: string,
  active: boolean,
  wait = ACTIVITY_STREAM_RENDER_THROTTLE_MS,
) {
  const [throttled, setThrottled] = useState(value);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    if (!active) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      lastUpdateRef.current = Date.now();
      setThrottled(value);
      return;
    }

    const now = Date.now();
    const remaining = wait - (now - lastUpdateRef.current);
    if (remaining <= 0 || lastUpdateRef.current === 0) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      lastUpdateRef.current = now;
      setThrottled(value);
      return;
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      lastUpdateRef.current = Date.now();
      setThrottled(value);
    }, remaining);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [active, value, wait]);

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  return throttled;
}

type PresenceProps = {
  children: ReactNode;
  initial?: boolean;
  mode?: "sync" | "wait" | "popLayout";
  onExitComplete?: () => void;
};

export function ActivityPresence({
  children,
  initial = false,
  mode = "sync",
  onExitComplete,
}: PresenceProps) {
  return (
    <AnimatePresence
      initial={initial}
      mode={mode}
      onExitComplete={onExitComplete}
    >
      {children}
    </AnimatePresence>
  );
}

interface ActivityEntryProps extends Omit<
  HTMLMotionProps<"div">,
  "animate" | "children" | "exit" | "initial" | "transition"
> {
  children: ReactNode;
  animate?: boolean;
  transition?: Transition;
  distance?: number;
  exitDistance?: number;
  blur?: number;
  exitBlur?: number;
  scale?: number;
  exitScale?: number;
  disableInitialAnimation?: boolean;
}

export const ActivityEntry = memo(function ActivityEntry({
  animate = true,
  children,
  transition,
  distance,
  exitDistance,
  disableInitialAnimation = false,
  ...props
}: ActivityEntryProps) {
  const reduced = Boolean(useReducedMotion());
  const enabled = animate && !reduced;

  return (
    <motion.div
      layout={enabled ? props.layout : undefined}
      {...entryMotion(enabled, {
        transition,
        distance,
        exitDistance,
        disableInitialAnimation,
      })}
      {...props}
    >
      {children}
    </motion.div>
  );
});

interface ActivityRevealProps extends Omit<
  HTMLMotionProps<"div">,
  "animate" | "children" | "exit" | "initial" | "transition"
> {
  children: ReactNode;
  animate?: boolean;
  transition?: Transition;
  distance?: number;
  exitDistance?: number;
  blur?: number;
  exitBlur?: number;
  scale?: number;
  exitScale?: number;
  disableInitialAnimation?: boolean;
}

export const ActivityReveal = memo(function ActivityReveal({
  animate = true,
  children,
  transition,
  distance,
  exitDistance,
  disableInitialAnimation = false,
  ...props
}: ActivityRevealProps) {
  const reduced = Boolean(useReducedMotion());
  const enabled = animate && !reduced;

  return (
    <motion.div
      {...revealMotion(enabled, {
        transition,
        distance,
        exitDistance,
        disableInitialAnimation,
      })}
      {...props}
    >
      {children}
    </motion.div>
  );
});

interface ActivityMeasuredBoxProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode;
  animate?: boolean;
  disableInitialAnimation?: boolean;
  fade?: boolean;
  watch?: boolean;
  open?: boolean;
  collapsedHeight?: number;
  animateToggle?: boolean;
}

const ActivityMeasuredBox = memo(function ActivityMeasuredBox({
  animate: shouldAnimateFlag = true,
  children,
  className,
  disableInitialAnimation = false,
  fade = true,
  watch = false,
  open = true,
  collapsedHeight = 0,
  animateToggle = true,
  style,
  ...props
}: ActivityMeasuredBoxProps) {
  const reduced = Boolean(useReducedMotion());
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const animRootRef = useRef<any>(null);
  const animBodyRef = useRef<any>(null);
  const cleanupObserverRef = useRef<(() => void) | undefined>(undefined);

  useLayoutEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = rootRef.current;
    const body = bodyRef.current;
    if (!root || !body) {
      return;
    }

    const canAnimate = shouldAnimateFlag && !reduced;
    const isInitialMount = !initializedRef.current;
    const shouldAnimate =
      canAnimate && (isInitialMount ? !disableInitialAnimation : animateToggle);

    const resetBody = () => {
      body.style.removeProperty("opacity");
      body.style.removeProperty("transform");
      body.style.removeProperty("filter");
      body.style.removeProperty("pointer-events");
    };

    const applyInstant = () => {
      root.style.height = open ? "auto" : `${collapsedHeight}px`;
      root.style.overflow = open ? "visible" : "clip";
      resetBody();
      if (!open && collapsedHeight === 0) {
        body.style.opacity = "0";
      }
      initializedRef.current = true;
    };

    if (!shouldAnimate) {
      animRootRef.current?.stop();
      animBodyRef.current?.stop();
      animRootRef.current = null;
      animBodyRef.current = null;
      if (cleanupObserverRef.current) {
        cleanupObserverRef.current();
        cleanupObserverRef.current = undefined;
      }
      applyInstant();
      return;
    }

    animRootRef.current?.stop();
    animBodyRef.current?.stop();

    const startHeight = root.getBoundingClientRect().height;
    const targetHeight = open
      ? Math.max(Math.ceil(body.getBoundingClientRect().height), 1)
      : collapsedHeight;
    const isCollapsing = !open;
    const isExpanding = open;

    root.style.height = `${startHeight}px`;
    root.style.overflow = "hidden";

    if (cleanupObserverRef.current) {
      cleanupObserverRef.current();
      cleanupObserverRef.current = undefined;
    }

    if (watch && open) {
      let resizeFrameId: number | null = null;
      const observer = new ResizeObserver(() => {
        if (resizeFrameId !== null) return;
        resizeFrameId = window.requestAnimationFrame(() => {
          resizeFrameId = null;
          const current = Math.ceil(root.getBoundingClientRect().height);
          const next = Math.max(
            Math.ceil(body.getBoundingClientRect().height),
            1,
          );
          if (Math.abs(next - current) <= 1) {
            return;
          }

          animRootRef.current?.stop();
          root.style.height = `${current}px`;
          root.style.overflow = "hidden";
          const resizeAnim = animate(root, { height: next }, GROW_SPRING);
          animRootRef.current = resizeAnim;

          // @ts-ignore
          Promise.resolve(resizeAnim)
            .then(() => {
              if (animRootRef.current !== resizeAnim) return;
              if (!open) return;
              root.style.height = "auto";
              root.style.overflow = "visible";
              animRootRef.current = null;
            })
            .catch(() => { });
        });
      });
      observer.observe(body);
      cleanupObserverRef.current = () => {
        if (resizeFrameId !== null) window.cancelAnimationFrame(resizeFrameId);
        observer.disconnect();
      };
    }

    const spring =
      collapsedHeight > 0 || !fade ? COLLAPSIBLE_SPRING : GROW_SPRING;

    if (fade && isExpanding) {
      if (isInitialMount) {
        body.style.opacity = "0";
        body.style.filter = "blur(4px)";
        body.style.transform = "translateY(4px)";
      }
      animBodyRef.current = animate(
        body,
        { opacity: 1, filter: "blur(0px)", transform: "translateY(0px)" },
        { ...spring, visualDuration: 0.4 },
      );
    } else if (fade && isCollapsing && collapsedHeight === 0) {
      body.style.pointerEvents = "none";
      animBodyRef.current = animate(
        body,
        { opacity: 0, filter: "blur(2px)", transform: "translateY(-4px)" },
        { ...spring, visualDuration: 0.3 },
      );
    } else {
      resetBody();
    }

    const rootAnim = animate(root, { height: targetHeight }, spring);
    animRootRef.current = rootAnim;

    // @ts-ignore
    Promise.resolve(rootAnim)
      .then(() => {
        if (animRootRef.current !== rootAnim) return;
        if (open) {
          root.style.height = "auto";
          root.style.overflow = "visible";
          resetBody();
        } else {
          root.style.height = `${collapsedHeight}px`;
          root.style.overflow = "clip";
          if (collapsedHeight === 0) {
            body.style.opacity = "0";
          } else {
            resetBody();
          }
        }
        initializedRef.current = true;
        animRootRef.current = null;
      })
      .catch(() => { });

    return () => {
      animRootRef.current?.stop();
      animBodyRef.current?.stop();
      if (cleanupObserverRef.current) cleanupObserverRef.current();
    };
  }, [
    shouldAnimateFlag,
    animateToggle,
    collapsedHeight,
    disableInitialAnimation,
    fade,
    open,
    reduced,
    watch,
  ]);

  return (
    <div ref={rootRef} className={className} style={style} {...props}>
      <div ref={bodyRef} className="min-h-0">
        {children}
      </div>
    </div>
  );
});

interface ActivityAppendGrowProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode;
  animate?: boolean;
  disableInitialAnimation?: boolean;
  fade?: boolean;
  watch?: boolean;
}

export const ActivityAppendGrow = memo(function ActivityAppendGrow(
  props: ActivityAppendGrowProps,
) {
  return <ActivityMeasuredBox {...props} />;
});

interface ActivityCollapsibleProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode;
  open: boolean;
  collapsedHeight?: number;
  animate?: boolean;
  fade?: boolean;
  watch?: boolean;
  disableInitialAnimation?: boolean;
}

export const ActivityCollapsible = memo(function ActivityCollapsible({
  open,
  collapsedHeight = 0,
  animate = true,
  fade = true,
  watch = false,
  disableInitialAnimation = false,
  children,
  className,
  ...props
}: ActivityCollapsibleProps) {
  return (
    <ActivityMeasuredBox
      open={open}
      collapsedHeight={collapsedHeight}
      animate={animate}
      animateToggle
      fade={fade}
      watch={watch}
      disableInitialAnimation={disableInitialAnimation}
      className={className}
      {...props}
    >
      {children}
    </ActivityMeasuredBox>
  );
});
