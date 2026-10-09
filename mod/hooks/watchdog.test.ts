import { describe, expect, test } from 'claude-code/testing'

import { deadlineVerdict, nextGrowth } from './watchdog'

const MIN = 60_000

describe('deadlineVerdict', () => {
  const at45 = { softMin: 45, hardMin: 60, isExtended: false, now: 45 * MIN }

  test('a transcript that grew in the last 5 min is extended once; quiet, already extended or no hard limit above it ends', () => {
    expect(deadlineVerdict({ ...at45, grewAt: 41 * MIN })).toBe('extend')
    expect(deadlineVerdict({ ...at45, grewAt: 39 * MIN })).toBe('end')
    expect(deadlineVerdict({ ...at45, grewAt: undefined })).toBe('end')
    expect(deadlineVerdict({ ...at45, grewAt: 59 * MIN, isExtended: true, now: 60 * MIN })).toBe('end')
    expect(deadlineVerdict({ ...at45, grewAt: 44 * MIN, hardMin: 45 })).toBe('end')
  })

  test('growth is only a change seen between two looks: a first look (a reload) is not', () => {
    const first = nextGrowth(undefined, 'abc', 1)
    expect(first.at).toBe(undefined)
    expect(nextGrowth(first, 'abc', 2)).toEqual({ mark: 'abc' })
    expect(nextGrowth(first, 'abcd', 3)).toEqual({ mark: 'abcd', at: 3 })
  })
})
