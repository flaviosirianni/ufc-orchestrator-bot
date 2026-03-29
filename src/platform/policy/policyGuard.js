import { getPolicyPack } from './policyPacks.js';

function containsRestrictedTerm(text = '', terms = []) {
  const normalizedText = String(text || '').toLowerCase();
  if (!normalizedText) return false;
  return terms.some((term) => normalizedText.includes(String(term || '').toLowerCase()));
}

export function enforcePolicyPack({ text = '', policyPackId = 'general_safe_advice' } = {}) {
  const pack = getPolicyPack(policyPackId);
  const safeText = String(text || '').trim();
  if (!safeText) return safeText;

  const restrictedTerms = Array.isArray(pack.restrictedTerms) ? pack.restrictedTerms : [];
  if (!restrictedTerms.length) {
    return safeText;
  }

  if (!containsRestrictedTerm(safeText, restrictedTerms)) {
    return safeText;
  }

  const notice = String(pack.escalationNotice || '').trim();
  if (!notice) {
    return safeText;
  }

  if (safeText.includes(notice)) {
    return safeText;
  }

  return `${safeText}\n\n${notice}`;
}
