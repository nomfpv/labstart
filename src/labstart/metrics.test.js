import { describe, expect, it } from 'vitest'
import { badgeText } from './metrics.js'

describe('badgeText', () => {
    it('keeps badges within four characters', () => {
        expect(badgeText({ value: 47.6, unit: '°C' })).toBe('48°')
        expect(badgeText({ value: 100, unit: '%' })).toBe('100%')
        expect(badgeText({ value: 61, unit: 'ms' })).toBe('61')
        expect(badgeText({ value: 83588, unit: '' })).toBe('84k')
        expect(badgeText({ value: '46/50', unit: '' })).toBe('46/5')
    })

    it('handles booleans and missing values', () => {
        expect(badgeText({ value: true })).toBe('ok')
        expect(badgeText({ value: false })).toBe('off')
        expect(badgeText({ value: null })).toBe('')
        expect(badgeText(undefined)).toBe('')
    })
})
