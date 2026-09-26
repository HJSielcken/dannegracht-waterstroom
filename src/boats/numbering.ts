// Short numbers for the boats on the map, so a marker can be matched with its row in the list.
//
// A boat keeps its number for as long as it is shown. When it disappears its number is freed
// and the next new boat gets the lowest free one, so the numbers stay small.

export class BoatNumbering {
  private numbers = new Map<string, number>();

  /**
   * Number every boat in `ids` (existing boats keep theirs) and forget boats not in it.
   * Returns the number per id.
   */
  assign(ids: readonly string[]): Map<string, number> {
    const present = new Set(ids);
    for (const id of this.numbers.keys()) if (!present.has(id)) this.numbers.delete(id);
    const used = new Set(this.numbers.values());
    let next = 1;
    for (const id of ids) {
      if (this.numbers.has(id)) continue;
      while (used.has(next)) next++;
      this.numbers.set(id, next);
      used.add(next);
    }
    return new Map(this.numbers);
  }
}
