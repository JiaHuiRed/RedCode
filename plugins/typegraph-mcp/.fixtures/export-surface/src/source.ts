export default function buildUser(): { readonly id: string } {
  return { id: "user-1" }
}

export const value = 42

export type UserShape = {
  readonly id: string
}

export interface Person {
  readonly name: string
}

export function greet(person: Person): string {
  return `hi ${person.name}`
}
