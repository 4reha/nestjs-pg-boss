const base = require('./jest.config.cjs');

// Runs test/postgres.spec.ts against a real Postgres started by Testcontainers. Needs Docker.
module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/postgres.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 60000,
};
