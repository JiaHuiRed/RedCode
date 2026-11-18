import { createContext, useContext, type ParentProps } from "solid-js"

type FieldDescription = { label: string; description?: string }
const FieldContext = createContext<FieldDescription>()

/** Associates a setting's visible label with its control, without duplicating copy. */
export function FormField(props: ParentProps<FieldDescription>) {
  return <FieldContext.Provider value={props}>{props.children}</FieldContext.Provider>
}

export const useFormField = () => useContext(FieldContext)
