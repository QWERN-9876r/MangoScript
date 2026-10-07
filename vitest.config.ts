import { defineConfig } from 'vitest/config';

// Tests run from the repository root. Without this file Vitest would take vite.config.ts, the
// configuration of the documentation site, whose root is site/.
export default defineConfig({});
