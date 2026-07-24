/**
 * Unit coverage for the native wire client's text-format value decoder. The
 * main suite runs on PGlite, which decodes types itself, so `decodeValue` (the
 * native engine's mapping to PGlite-compatible JS types) is otherwise only
 * exercised behind the binary-gated native engine. These tests pin the pieces
 * that have diverged from PGlite before: int8 precision (scalar + array) and
 * the array element OIDs (incl. `_name`, which the studio's enum page relies on).
 */
import { describe, expect, it } from 'vitest'
import { decodeValue, parsePgArray } from '../src/node/native/wire.js'

describe('decodeValue: scalars', () => {
  it('bool (16)', () => {
    expect(decodeValue('t', 16)).toBe(true)
    expect(decodeValue('f', 16)).toBe(false)
  })

  it('int4 (23) is a number', () => {
    expect(decodeValue('42', 23)).toBe(42)
  })

  it('int8 (20) keeps safe integers as numbers but preserves large values as strings', () => {
    expect(decodeValue('42', 20)).toBe(42)
    // 9223372036854775807 (max bigint) is well beyond 2^53 and would lose precision as a number
    expect(decodeValue('9223372036854775807', 20)).toBe('9223372036854775807')
  })

  it('json/jsonb (114/3802) parse', () => {
    expect(decodeValue('{"a":1}', 114)).toEqual({ a: 1 })
    expect(decodeValue('[1,2]', 3802)).toEqual([1, 2])
  })

  it('unknown OID falls through to the raw text', () => {
    expect(decodeValue('whatever', 999999)).toBe('whatever')
  })
})

describe('decodeValue: arrays', () => {
  it('_bool (1000)', () => {
    expect(decodeValue('{t,f,t}', 1000)).toEqual([true, false, true])
  })

  it('_name (1003) — array_agg over pg_enum.enumlabel (studio enums page)', () => {
    expect(decodeValue('{pending,paid,shipped}', 1003)).toEqual(['pending', 'paid', 'shipped'])
  })

  it('_text (1009)', () => {
    expect(decodeValue('{a,b,c}', 1009)).toEqual(['a', 'b', 'c'])
  })

  it('_int4 (1007)', () => {
    expect(decodeValue('{1,2,3}', 1007)).toEqual([1, 2, 3])
  })

  it('_int8 (1016) preserves large values as strings, like the scalar case', () => {
    expect(decodeValue('{1,9223372036854775807}', 1016)).toEqual([1, '9223372036854775807'])
  })

  it('_int8 (1016) keeps NULLs', () => {
    expect(decodeValue('{1,NULL,3}', 1016)).toEqual([1, null, 3])
  })
})

describe('parsePgArray', () => {
  it('handles quoted elements, NULL, and empty input', () => {
    expect(parsePgArray('{"a b",c,NULL}')).toEqual(['a b', 'c', null])
    expect(parsePgArray('{}')).toEqual([])
  })
})
