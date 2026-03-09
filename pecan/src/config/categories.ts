/**
 * Category Configuration
 * 
 * Centralized configuration for CAN message categories.
 * Parses a simple text file format for easy configuration.
 * 
 * Format:
 * CategoryName,Color,MessageIDs
 * 
 * Examples:
 * BMS,bg-orange-400,1,2,100-110
 * VCU,bg-sky-400,256,512
 * TEST MSG,bg-purple-500,256,512
 */

import categoryConfig from '../assets/categories.txt?raw';

export interface Category {
  name: string;
  color: string;
  messageIds: Set<number>;
}

/**
 * Default category for uncategorized messages
 */
export const DEFAULT_CATEGORY = {
  name: "NO CAT",
  color: "bg-blue-500"
};

/**
 * Parse a range string like "100-110" into an array of numbers
 */
function parseRange(range: string): number[] {
  const parts = range.split('-');
  if (parts.length === 2) {
    const start = parseInt(parts[0]);
    const end = parseInt(parts[1]);
    if (!isNaN(start) && !isNaN(end)) {
      const result: number[] = [];
      for (let i = start; i <= end; i++) {
        result.push(i);
      }
      return result;
    }
  }
  return [];
}

/**
 * Parse the category configuration file
 */
function parseCategories(configText: string): Category[] {
  const categories: Category[] = [];
  const lines = configText.split('\n');

  for (const line of lines) {
    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    const parts = trimmed.split(',').map(p => p.trim());
    if (parts.length < 3) {
      console.warn(`Invalid category line: ${line}`);
      continue;
    }

    const name = parts[0];
    const color = parts[1];
    const messageIds = new Set<number>();

    // Parse message IDs (parts[2] onwards)
    for (let i = 2; i < parts.length; i++) {
      const part = parts[i];

      // Check if it's a range (e.g., "100-110")
      if (part.includes('-')) {
        const rangeIds = parseRange(part);
        rangeIds.forEach(id => messageIds.add(id));
      } else {
        // Single ID
        const id = parseInt(part);
        if (!isNaN(id)) {
          messageIds.add(id);
        }
      }
    }

    categories.push({ name, color, messageIds });
  }

  return categories;
}

/**
 * Loaded categories from configuration file
 */
export let CATEGORIES: Category[] = parseCategories(categoryConfig);
let currentCategoryConfigText = categoryConfig;

/**
 * Returns the raw text representation currently driving the categories
 */
export function getCategoryConfigString(): string {
  return currentCategoryConfigText;
}

/**
 * Overrides the internal category configurations with a new text string
 * @param configText - The raw category configuration text
 */
export function updateCategories(configText: string) {
  currentCategoryConfigText = configText;
  CATEGORIES = parseCategories(configText);
}


/**
 * Determine the category for a CAN message
 * @param msgID - CAN message ID (as string)
 * @param explicitCategory - Optional explicit category override
 * @returns Category name
 */
export function determineCategory(
  msgID: string,
  explicitCategory?: string
): string {
  // If explicit category is provided, use it
  if (explicitCategory) return explicitCategory;

  // Parse hex ("0x1A3") or decimal ID strings
  const numericId = msgID.startsWith("0x") || msgID.startsWith("0X")
    ? parseInt(msgID, 16)
    : parseInt(msgID, 10);
  if (isNaN(numericId)) return DEFAULT_CATEGORY.name;

  // Find first matching category
  for (const category of CATEGORIES) {
    if (category.messageIds.has(numericId)) {
      return category.name;
    }
  }

  // No match found, return default
  return DEFAULT_CATEGORY.name;
}

/**
 * Get the color class for a category
 * @param categoryName - Category name
 * @returns Tailwind CSS color class
 */
export function getCategoryColor(categoryName: string): string {
  const category = CATEGORIES.find(cat => cat.name === categoryName);
  return category?.color ?? DEFAULT_CATEGORY.color;
}

/**
 * Get all category names
 * @returns Array of category names
 */
export function getAllCategoryNames(): string[] {
  return CATEGORIES.map(cat => cat.name);
}
