// MAIN-world content script, run once per page at document_start.
// Built as a self-contained IIFE (vite.content.config.ts) because content scripts can't use ES imports.
import { installHook, type HookWindow } from './intercept';

installHook(window as unknown as HookWindow);
