var config = require('config');

/**
 * Feature flags utility
 * Checks if features are enabled based on config
 */

/**
 * Check if courses feature is enabled
 * @returns {boolean} - True if enabled, false if disabled
 */
function isCoursesEnabled() {
  // Default to true if not specified
  if (!config.features || typeof config.features.courses === 'undefined') {
    return true;
  }
  return config.features.courses === true;
}

/**
 * Check if public self-service (signup + save/remix) is enabled
 * @returns {boolean} - True if enabled, false if disabled
 */
function isSelfServiceEnabled() {
  // Default to true if not specified
  if (!config.features || typeof config.features.selfService === 'undefined') {
    return true;
  }
  return config.features.selfService === true;
}

/**
 * Check if a trinket type (language) is enabled
 * @param {string} lang - The trinket language/type (e.g., 'python', 'java')
 * @returns {boolean} - True if enabled, false if disabled
 */
function isTrinketTypeEnabled(lang) {
  var trinketFeatures = config.features && config.features.trinkets;

  if (!trinketFeatures) {
    // If no feature config, default to enabled
    return true;
  }

  // Check if explicitly set; default to true if not specified
  if (trinketFeatures.hasOwnProperty(lang)) {
    return trinketFeatures[lang] === true;
  }

  // Unknown types default to disabled for safety
  return false;
}

/**
 * Get list of all enabled trinket types
 * @returns {string[]} - Array of enabled trinket type names
 */
function getEnabledTrinketTypes() {
  var trinketFeatures = config.features && config.features.trinkets;

  if (!trinketFeatures) {
    return [];
  }

  return Object.keys(trinketFeatures).filter(function(lang) {
    return trinketFeatures[lang] === true;
  });
}

/**
 * Get list of all disabled trinket types
 * @returns {string[]} - Array of disabled trinket type names
 */
function getDisabledTrinketTypes() {
  var trinketFeatures = config.features && config.features.trinkets;

  if (!trinketFeatures) {
    return [];
  }

  return Object.keys(trinketFeatures).filter(function(lang) {
    return trinketFeatures[lang] === false;
  });
}

/**
 * Check if a string is a known trinket type (regardless of enabled/disabled)
 * @param {string} lang - The potential trinket language/type
 * @returns {boolean} - True if it's a known type, false otherwise
 */
function isKnownTrinketType(lang) {
  var trinketFeatures = config.features && config.features.trinkets;

  if (!trinketFeatures) {
    return false;
  }

  return trinketFeatures.hasOwnProperty(lang);
}

module.exports = {
  isCoursesEnabled: isCoursesEnabled,
  isSelfServiceEnabled: isSelfServiceEnabled,
  isTrinketTypeEnabled: isTrinketTypeEnabled,
  getEnabledTrinketTypes: getEnabledTrinketTypes,
  getDisabledTrinketTypes: getDisabledTrinketTypes,
  isKnownTrinketType: isKnownTrinketType
};
