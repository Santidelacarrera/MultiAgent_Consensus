/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/agents', '<rootDir>/orchestrator'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 20000,
};
