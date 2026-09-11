import type { Equipment, Property, ServiceEvent, SearchResult } from '../types';
import { equipment, properties, serviceEvents } from '../mocks/data';

// Simple fuzzy matching algorithm
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  // Exact match
  if (s1 === s2) return 100;

  // Contains match
  if (s1.includes(s2) || s2.includes(s1)) return 85;

  // Levenshtein distance (simplified)
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;

  if (longer.length === 0) return 100;

  const editDistance = levenshteinDistance(longer, shorter);
  const similarity = ((longer.length - editDistance) / longer.length) * 100;

  return Math.max(0, similarity);
}

function levenshteinDistance(s1: string, s2: string): number {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

export async function searchEquipment(query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  // Search by serial number (highest priority)
  equipment.forEach((eq) => {
    const serialMatch = calculateSimilarity(eq.serialNumber, query);
    if (serialMatch > 70) {
      results.push({
        type: 'equipment',
        data: eq,
        matchScore: serialMatch,
        confidence: 95,
        matchReason: `Serial number match: ${eq.serialNumber}`,
      });
    }
  });

  // Search by model number
  equipment.forEach((eq) => {
    const modelMatch = calculateSimilarity(eq.modelNumber, query);
    if (modelMatch > 70) {
      results.push({
        type: 'equipment',
        data: eq,
        matchScore: modelMatch,
        confidence: 88,
        matchReason: `Model match: ${eq.modelNumber}`,
      });
    }
  });

  // Search by manufacturer
  equipment.forEach((eq) => {
    const mfgMatch = calculateSimilarity(eq.manufacturer, query);
    if (mfgMatch > 80 && !results.some((r) => r.data.id === eq.id)) {
      results.push({
        type: 'equipment',
        data: eq,
        matchScore: mfgMatch,
        confidence: 80,
        matchReason: `Manufacturer: ${eq.manufacturer}`,
      });
    }
  });

  // Remove duplicates and sort by score
  const uniqueResults = Array.from(
    new Map(results.map((r) => [r.data.id, r])).values()
  );

  return uniqueResults.sort((a, b) => b.matchScore - a.matchScore);
}

export async function searchByAddress(query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  properties.forEach((prop) => {
    const addressMatch = calculateSimilarity(prop.address, query);
    const cityMatch = calculateSimilarity(prop.city, query);
    const customerMatch = calculateSimilarity(prop.customerName, query);

    const bestMatch = Math.max(addressMatch, cityMatch, customerMatch);

    if (bestMatch > 60) {
      // Add property as result
      results.push({
        type: 'property',
        data: prop,
        matchScore: bestMatch,
        confidence: 90,
        matchReason: `Property found at ${prop.address}`,
      });

      // Add all equipment at this property
      prop.equipment.forEach((eq) => {
        results.push({
          type: 'equipment',
          data: eq,
          matchScore: bestMatch - 5,
          confidence: 88,
          matchReason: `Equipment at matched property`,
        });
      });
    }
  });

  return results.sort((a, b) => b.matchScore - a.matchScore);
}

export async function searchByTechnician(query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  serviceEvents.forEach((svc) => {
    const techMatch = calculateSimilarity(svc.technicianName, query);
    if (techMatch > 70) {
      results.push({
        type: 'service_event',
        data: svc,
        matchScore: techMatch,
        confidence: 92,
        matchReason: `Service by ${svc.technicianName}`,
      });
    }
  });

  return results.sort((a, b) => b.matchScore - a.matchScore);
}

export async function searchByDate(query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  // Parse date from query (simple: "2024", "march 2024", etc.)
  serviceEvents.forEach((svc) => {
    const serviceDate = svc.date.toLocaleDateString();
    if (serviceDate.includes(query) || svc.date.getFullYear().toString() === query) {
      results.push({
        type: 'service_event',
        data: svc,
        matchScore: 85,
        confidence: 85,
        matchReason: `Service on ${serviceDate}`,
      });
    }
  });

  return results.sort((a, b) => {
    const aDate = (a.data as any).date || new Date(0);
    const bDate = (b.data as any).date || new Date(0);
    return new Date(bDate).getTime() - new Date(aDate).getTime();
  });
}

export async function performSearch(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  const results: SearchResult[] = [];

  // Detect search intent
  const isAddress = /street|avenue|road|blvd|drive|lane|circle|court|ct|rd|ave|st|dr|ln/i.test(
    query
  );
  const isDate = /\d{1,2}\/\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}/i.test(
    query
  );
  const isTech = /tech|technician|maria|mike|carlos|jenny|david|brian|miguel/i.test(query);

  // Multi-strategy search
  if (isAddress) {
    const addressResults = await searchByAddress(query);
    results.push(...addressResults);
  }

  if (isDate) {
    const dateResults = await searchByDate(query);
    results.push(...dateResults);
  }

  if (isTech) {
    const techResults = await searchByTechnician(query);
    results.push(...techResults);
  }

  // Always search equipment (serial, model)
  const equipmentResults = await searchEquipment(query);
  results.push(...equipmentResults);

  // Deduplicate by ID
  const uniqueMap = new Map<string, SearchResult>();
  results.forEach((result) => {
    if (!result.data || !result.data.id) return; // Skip invalid results
    const key = `${result.type}-${result.data.id}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, result);
    }
  });

  return Array.from(uniqueMap.values())
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 20); // Limit to 20 results
}
