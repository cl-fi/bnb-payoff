import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

export interface UseAnchoredMenuOptions {
  /** Align popover to inline-start (left in LTR) or inline-end (right in LTR) of trigger */
  align?: "start" | "end";
  /** Disable popover behavior (e.g. mobile uses a bottom-sheet <dialog> instead) */
  enabled?: boolean;
  /** Optional external controlled open trigger (e.g. opened from WalletModal) */
  externalOpen?: boolean;
  /** Called when the menu closes */
  onClose?: () => void;
}

function getFeatureSupport() {
  if (typeof window === "undefined" || typeof HTMLElement === "undefined") {
    return {
      popover: true,
      commandFor: false,
      focusgroup: false,
      positionArea: true,
      toggleSource: true,
    };
  }
  const popover = Object.hasOwn(HTMLElement.prototype, "popover");
  const commandFor =
    typeof HTMLButtonElement !== "undefined" &&
    "commandForElement" in HTMLButtonElement.prototype;
  const focusgroup = "focusGroup" in HTMLElement.prototype;
  const positionArea =
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("position-area: block-end");
  const toggleSource =
    typeof ToggleEvent !== "undefined" && "source" in ToggleEvent.prototype;
  return { popover, commandFor, focusgroup, positionArea, toggleSource };
}

function getEnabledMenuItems(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button[role="menuitemradio"], button[role="menuitem"], button:not([role])'
    )
  ).filter(
    (el) =>
      !(el as HTMLButtonElement).disabled &&
      el.getAttribute("aria-disabled") !== "true"
  );
}

/**
 * Shared accessible anchored popover menu hook:
 * - Native Popover API (`popover="auto"`) + Invoker Commands (`commandfor`/`command="toggle-popover"`)
 *   with automatic `popovertarget` fallback when invokers are unsupported.
 * - Native CSS Anchor Positioning (`position-area`) gated behind `@supports`, with
 *   viewport-clamped `position: fixed` script fallback when `position-area` is unsupported.
 * - Native `focusgroup="menu nomemory"` with `role="menu"` + arrow/Home/End fallback
 *   only when `'focusGroup' in HTMLElement.prototype` is false.
 */
export function useAnchoredMenu({
  align = "start",
  enabled = true,
  externalOpen = false,
  onClose,
}: UseAnchoredMenuOptions = {}) {
  const uid = useId().replace(/:/g, "");
  const triggerId = `payoff-menu-trigger-${uid}`;
  const popoverId = `payoff-menu-popover-${uid}`;
  const anchorToken = `--payoff-anchor-${uid}`;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const menuGroupRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const enterOnOpenRef = useRef(false);
  const lastActivationPointerRef = useRef(false);

  const support = getFeatureSupport();

  const positionFallbackPopover = useCallback(() => {
    if (support.positionArea) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const gap = 8;
    const margin = 12;
    const tr = trigger.getBoundingClientRect();
    const pr = popover.getBoundingClientRect();
    const menuW = pr.width || popover.offsetWidth || 200;
    const menuH = pr.height || popover.offsetHeight || 120;

    let left = align === "end" ? tr.right - menuW : tr.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuW - margin));

    let top = tr.bottom + gap;
    if (top + menuH > window.innerHeight - margin && tr.top - gap - menuH >= margin) {
      top = tr.top - gap - menuH;
    } else {
      top = Math.max(margin, Math.min(top, window.innerHeight - menuH - margin));
    }

    popover.setAttribute("data-js-positioned", "");
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }, [align, support.positionArea]);

  // Explicit anchor-name / position-anchor only when implicit source anchoring is unsupported
  useEffect(() => {
    if (!enabled || !support.positionArea || support.toggleSource) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    trigger.style.setProperty("anchor-name", anchorToken);
    popover.style.setProperty("position-anchor", anchorToken);
    return () => {
      trigger.style.removeProperty("anchor-name");
      popover.style.removeProperty("position-anchor");
    };
  }, [enabled, support.positionArea, support.toggleSource, anchorToken]);

  // Fallback for browsers without native focusgroup: set role="menu" + Arrow/Home/End navigation
  useEffect(() => {
    if (!enabled || support.focusgroup) return;
    const group = menuGroupRef.current;
    if (!group) return;
    group.setAttribute("role", "menu");
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = getEnabledMenuItems(group);
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (current < 0) return;
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
              items.length;
      event.preventDefault();
      event.stopImmediatePropagation();
      items[next]?.focus({ preventScroll: true });
    };
    group.addEventListener("keydown", onKeyDown, true);
    return () => {
      group.removeEventListener("keydown", onKeyDown, true);
    };
  }, [enabled, support.focusgroup]);

  const hideMenu = useCallback(
    (restoreFocus = false) => {
      const popover = popoverRef.current;
      if (support.popover && popover) {
        if (popover.matches(":popover-open")) {
          popover.hidePopover();
        }
      } else {
        setOpen(false);
        onClose?.();
      }
      if (restoreFocus) {
        triggerRef.current?.focus({ preventScroll: true });
      }
    },
    [onClose, support.popover]
  );

  const showMenuImperatively = useCallback(() => {
    const popover = popoverRef.current;
    const trigger = triggerRef.current;
    if (!popover) return;
    if (support.popover) {
      if (popover.matches(":popover-open")) return;
      try {
        (
          popover as unknown as {
            showPopover: (opts?: { source?: HTMLElement | null }) => void;
          }
        ).showPopover(trigger ? { source: trigger } : undefined);
      } catch {
        try {
          popover.showPopover();
        } catch {
          // ignore if already open or detached
        }
      }
    } else {
      setOpen(true);
    }
  }, [support.popover]);

  // Listen to native Popover toggle events to sync aria-expanded, keyboard focus entry, and fallback placement
  useEffect(() => {
    if (!enabled || !support.popover) return;
    const popover = popoverRef.current;
    if (!popover) return;

    const onToggle = (e: Event) => {
      const te = e as ToggleEvent;
      const isNowOpen = te.newState === "open";
      setOpen(isNowOpen);

      if (isNowOpen) {
        positionFallbackPopover();
        if (enterOnOpenRef.current) {
          enterOnOpenRef.current = false;
          requestAnimationFrame(() => {
            const items = getEnabledMenuItems(menuGroupRef.current);
            items[0]?.focus({ preventScroll: true });
          });
        }
      } else {
        enterOnOpenRef.current = false;
        popover.removeAttribute("data-js-positioned");
        popover.style.left = "";
        popover.style.top = "";
        onClose?.();
      }
    };

    popover.addEventListener("toggle", onToggle);
    return () => {
      popover.removeEventListener("toggle", onToggle);
    };
  }, [enabled, onClose, positionFallbackPopover, support.popover]);

  // Sync external controlled open requests (e.g. clicking "Switch market" from WalletModal)
  useEffect(() => {
    if (!enabled || !externalOpen) return;
    const rafId = requestAnimationFrame(() => {
      showMenuImperatively();
    });
    return () => cancelAnimationFrame(rafId);
  }, [enabled, externalOpen, showMenuImperatively]);

  // Close when focus leaves menu + reposition fallback on resize/scroll while open
  useEffect(() => {
    if (!enabled || !open) return;

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      hideMenu(false);
    };

    const onPointerDownDoc = (e: MouseEvent) => {
      if (support.popover) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      hideMenu(false);
    };

    const onViewportChange = () => positionFallbackPopover();
    if (!support.positionArea) {
      positionFallbackPopover();
      window.addEventListener("resize", onViewportChange);
      window.addEventListener("scroll", onViewportChange, true);
    }

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("mousedown", onPointerDownDoc);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("mousedown", onPointerDownDoc);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [enabled, hideMenu, open, positionFallbackPopover, support.popover, support.positionArea]);

  const onTriggerPointerDown = (_e: PointerEvent<HTMLButtonElement>) => {
    lastActivationPointerRef.current = true;
    enterOnOpenRef.current = false;
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!enabled) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      lastActivationPointerRef.current = false;
      if (open) {
        const items = getEnabledMenuItems(menuGroupRef.current);
        items[0]?.focus({ preventScroll: true });
      } else {
        enterOnOpenRef.current = true;
        if (support.popover) {
          triggerRef.current?.click();
        } else {
          setOpen(true);
          requestAnimationFrame(() => {
            const items = getEnabledMenuItems(menuGroupRef.current);
            items[0]?.focus({ preventScroll: true });
          });
        }
      }
    } else if (e.key === "Enter" || e.key === " ") {
      lastActivationPointerRef.current = false;
      if (!open) {
        enterOnOpenRef.current = true;
      }
    }
  };

  const onPopoverKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hideMenu(true);
    } else if (e.key === "Tab") {
      hideMenu(false);
    }
  };

  // Trigger attributes: prefer commandfor/command="toggle-popover"; fall back cleanly when unsupported
  const triggerInvokerProps: Record<string, unknown> = !enabled
    ? {}
    : support.popover
      ? support.commandFor
        ? { commandfor: popoverId, command: "toggle-popover" }
        : { popoverTarget: popoverId }
      : {
          onClick: () => setOpen((prev) => !prev),
        };

  return {
    open,
    triggerId,
    popoverId,
    triggerRef,
    popoverRef,
    menuGroupRef,
    supportsPopover: support.popover,
    triggerInvokerProps,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onPopoverKeyDown,
    hideMenu,
    showMenuImperatively,
    lastActivationPointerRef,
  };
}
