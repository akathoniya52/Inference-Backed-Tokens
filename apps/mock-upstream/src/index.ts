/** Default port of the mock OpenAI-compatible upstream. */
export const MOCK_UPSTREAM_PORT = 4010;

export {
  DEFAULT_MOCK_API_KEY,
  MOCK_MODES,
  completionFor,
  countTokens,
  createMockUpstream,
  type MockCall,
  type MockMode,
  type MockUpstream,
  type MockUpstreamOptions,
} from './server.js';
