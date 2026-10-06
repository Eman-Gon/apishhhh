// These labels and outputs are illustrative. No provider account is accessed.
export const providers = [
  { id: 'claude', name: 'Claude', product: 'Demo Claude usage', description: 'Simulated assistant tasks; not a Claude subscription or API balance.' },
  { id: 'codex', name: 'Codex', product: 'Demo Codex usage', description: 'Simulated coding tasks; not transferable OpenAI or ChatGPT credits.' },
  { id: 'lovable', name: 'Lovable', product: 'Demo Lovable usage', description: 'Simulated app-building tasks; no Lovable integration.' },
  { id: 'chatgpt', name: 'ChatGPT', product: 'Demo ChatGPT usage', description: 'Illustrative catalog entry only; no ChatGPT account connection or subscription sharing.' },
  { id: 'exa', name: 'Exa', product: 'Demo Exa usage', description: 'Simulated research tasks; no Exa API connection.' },
  { id: 'gemini', name: 'Gemini', product: 'Demo Gemini usage', description: 'Simulated assistant tasks; no Google account or API connection.' },
  { id: 'mistral', name: 'Mistral', product: 'Demo Mistral usage', description: 'Simulated assistant tasks; no Mistral API connection.' },
  { id: 'openrouter', name: 'OpenRouter', product: 'Demo OpenRouter usage', description: 'Simulated model-routing tasks; no OpenRouter API connection.' },
];

export function simulateJob(providerId, prompt, units) {
  const provider = providers.find(p => p.id === providerId);
  if (!provider) throw new Error('Unknown demo provider');
  return {
    mode: 'simulated',
    text: `Demo receipt: ${provider.name} task completed using ${units.toLocaleString('en-US')} demo credit units. Request: ${prompt.slice(0, 160)}`,
    providerCalled: false,
    units,
  };
}
