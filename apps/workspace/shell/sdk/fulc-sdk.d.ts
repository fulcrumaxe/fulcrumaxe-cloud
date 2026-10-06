// `@fulc/sdk` — public type declarations for marketplace app developers.
//
// This file consolidates the SDK surface into a single ambient declaration
// usable in two ways:
//
//   1. ESM authoring (TS apps in the fulcrumaxe-os source tree, or third parties using
//      their own build tool): import directly from "@fulc/sdk" or from this
//      bundle path. Types live alongside the runtime, so `import { register }
//      from "@fulc/sdk"` returns the typed surface declared below.
//
//   2. Plain-JS authoring with the UMD bundle (`<script src="/sdk/fulc-sdk.umd.js">`):
//      add this file to your tsconfig's `files` array (or reference it via
//      `/// <reference path="…/fulc-sdk.d.ts" />`) and `window.FULC` is typed.
//
// Keep this file in sync with `crates/fulc-shell/src-ts/sdk/types.ts` — that
// is the source of truth; this file is the publishable mirror.

declare module "@fulc/sdk" {
  // ─── Manifest mirror ─────────────────────────────────────────────────────
  export interface FULCFrontendManifest {
    entry_point: string;
    icon?: string;
    category?: string;
  }
  export interface FULCBackendManifest {
    runtime: "none" | "bun-ts" | "wasm" | "container" | "native";
    entry_point?: string;
    idle_timeout_seconds?: number;
  }
  export interface FULCCapabilityDeclaration {
    id: string;
    display_name: string;
    default_tier?: "free" | "pro" | "enterprise" | string;
    description?: string;
  }
  export interface FULCAppManifest {
    id: string;
    name: string;
    version: string;
    author?: string;
    description?: string;
    homepage?: string;
    frontend: FULCFrontendManifest;
    backend?: FULCBackendManifest;
    capabilities?: FULCCapabilityDeclaration[];
    required_entitlements?: string[];
    min_fulc_version?: string;
  }

  // ─── App lifecycle ────────────────────────────────────────────────────────
  export interface FULCAppContext {
    appId: string;
    contentEl: HTMLElement;
    /** Set when another app opened this one with an argument; untrusted, validate every field. */
    launchArg?: Readonly<Record<string, unknown>>;
  }
  export interface FULCRegisterOptions {
    id?: string;
    title: string;
    icon?: string;
    defaultSize?: { w: number; h: number };
    minSize?: { w: number; h: number };
    onOpen?: (ctx: FULCAppContext) => void | Promise<void>;
    onClose?: (appId: string) => void;
    onFocus?: (appId: string) => void;
    onResize?: (appId: string) => void;
    /** The shell hid the window (minimized, another workspace). */
    onHide?: (appId: string) => void;
    /** The shell showed the window again. */
    onShow?: (appId: string) => void;
    /** Another app opened this one with an argument while it is already open (`onOpen` gets it on a first open). Untrusted: validate every field. */
    onLaunch?: (ctx: { appId: string; launchArg: Readonly<Record<string, unknown>> }) => void;
  }
  export function register(options: FULCRegisterOptions): void;
  export function ready(cb: () => void): void;
  export function destroy(): void;

  // ─── Backend client ───────────────────────────────────────────────────────
  export type FULCHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  export interface FULCRequestOptions {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    raw?: boolean;
  }
  export class FULCBackendError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body: unknown);
  }
  export function request<T = unknown>(
    method: FULCHttpMethod,
    path: string,
    body?: unknown,
    options?: FULCRequestOptions,
  ): Promise<T>;

  export type FULCWSEventMap = Record<string, unknown>;
  export type FULCWSListener<T> = (payload: T) => void;
  export interface FULCWebSocket<T extends FULCWSEventMap = FULCWSEventMap> {
    on<K extends keyof T & string>(event: K, listener: FULCWSListener<T[K]>): void;
    on(event: "open", listener: () => void): void;
    on(event: "close", listener: (info: { code: number; reason: string }) => void): void;
    on(event: "error", listener: (err: Event) => void): void;
    on(event: "message", listener: (raw: MessageEvent) => void): void;
    off(event: string, listener: (...args: any[]) => void): void;
    send<K extends keyof T & string>(event: K, payload: T[K]): void;
    send(raw: string | ArrayBufferLike | Blob): void;
    close(code?: number, reason?: string): void;
    readonly isOpen: boolean;
  }
  export function openWS<T extends FULCWSEventMap = FULCWSEventMap>(
    path: string,
  ): FULCWebSocket<T>;

  // ─── Per-app state ────────────────────────────────────────────────────────
  export interface FULCAppState {
    get<T = unknown>(key: string): T | null;
    set<T = unknown>(key: string, value: T): void;
    remove(key: string): void;
    clear(): void;
    keys(): string[];
  }
  export const state: FULCAppState;

  // ─── Events ───────────────────────────────────────────────────────────────
  export interface FULCEventBus {
    on<T = unknown>(event: string, listener: (payload: T) => void): () => void;
    off<T = unknown>(event: string, listener: (payload: T) => void): void;
    emit<T = unknown>(event: string, payload?: T): void;
    broadcast<T = unknown>(event: string, payload?: T): void;
  }
  export const events: FULCEventBus;

  // ─── Theme ────────────────────────────────────────────────────────────────
  export interface FULCThemeExperience {
    id: string;
    name?: string;
    tokens?: Record<string, string>;
    layout?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }
  export interface FULCThemeSnapshot {
    experience: FULCThemeExperience | null;
    tokens: Record<string, string>;
    token(name: string): string;
  }
  export interface FULCThemeApi {
    current(): FULCThemeSnapshot;
    onChange(cb: (snapshot: FULCThemeSnapshot) => void): () => void;
  }
  export const theme: FULCThemeApi;

  // ─── Entitlements ─────────────────────────────────────────────────────────
  export interface FULCEntitlementDecision {
    capability: string;
    allowed: boolean;
    reason?: string;
  }
  export interface FULCGateOptions {
    ctaLabel?: string;
    upgradeMessage?: string;
    noLockIcon?: boolean;
  }
  export interface FULCEntitlementsApi {
    can(capability: string): boolean;
    check(capability: string): FULCEntitlementDecision;
    gate(element: HTMLElement, capability: string, options?: FULCGateOptions): void;
    ungate(element: HTMLElement): void;
  }
  export const entitlements: FULCEntitlementsApi;

  // ─── Window manipulation ──────────────────────────────────────────────────
  export interface FULCWindowApi {
    setTitle(title: string): void;
    resize(size: { w: number; h: number }): void;
    close(): void;
    focus(): void;
    isOpen(): boolean;
  }
  /** Exported under the name `window` in the SDK; renamed to avoid shadowing the global. */
  const windowApi: FULCWindowApi;
  export { windowApi as window };

  // ─── Continuity ───────────────────────────────────────────────────────────
  export interface FULCSessionState<T = Record<string, unknown>> {
    version: number;
    payload: T;
    capturedAt: number;
  }
  export type FULCContinuityUnsubscribe = () => void;
  export interface FULCContinuityApi {
    onSessionSave<T = Record<string, unknown>>(
      cb: () => T | Promise<T>,
    ): FULCContinuityUnsubscribe;
    onSessionRestore<T = Record<string, unknown>>(
      cb: (state: FULCSessionState<T>) => void | Promise<void>,
    ): FULCContinuityUnsubscribe;
    collect<T = Record<string, unknown>>(): Promise<FULCSessionState<T> | null>;
    apply<T = Record<string, unknown>>(state: FULCSessionState<T>): Promise<void>;
  }
  export const continuity: FULCContinuityApi;
  export function onSessionSave<T = Record<string, unknown>>(
    cb: () => T | Promise<T>,
  ): FULCContinuityUnsubscribe;
  export function onSessionRestore<T = Record<string, unknown>>(
    cb: (state: FULCSessionState<T>) => void | Promise<void>,
  ): FULCContinuityUnsubscribe;

  // ─── Bundle metadata ──────────────────────────────────────────────────────
  export const VERSION: string;

  /** Grouped namespace mirrored on `window.FULC` by the UMD bundle. */
  export const FULC: {
    VERSION: string;
    register: typeof register;
    ready: typeof ready;
    destroy: typeof destroy;
    backend: { request: typeof request; openWS: typeof openWS; FULCBackendError: typeof FULCBackendError };
    state: FULCAppState;
    events: FULCEventBus;
    theme: FULCThemeApi;
    entitlements: FULCEntitlementsApi;
    window: FULCWindowApi;
    continuity: FULCContinuityApi;
    onSessionSave: typeof onSessionSave;
    onSessionRestore: typeof onSessionRestore;
  };

  export default FULC;
}

// When the UMD bundle loads, it assigns the namespace to `window.FULC`.
declare global {
  interface Window {
    JPOS: import("@fulc/sdk").default;
    /** Set by the marketplace launcher before the app's entry script runs. */
    __FULC_BASEAPP_ID__?: string;
  }
}
