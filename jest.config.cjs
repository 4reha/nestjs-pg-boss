// Jest has to run in its experimental ESM mode, because pg-boss and Nest 12 are ESM only.
// The npm scripts start it with `node --experimental-vm-modules`.
module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  resolver: '<rootDir>/test/jest-resolver.cjs',
  // SWC strips types and compiles the legacy decorators Nest uses. It does not type check;
  // `npm run typecheck` does that.
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: false },
        },
      },
    ],
  },
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  // The Postgres spec needs Docker, so it has its own script and config.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/postgres.spec.ts'],
  testTimeout: 20000,
};
