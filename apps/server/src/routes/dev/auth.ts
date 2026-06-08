import { type DBFieldAttribute, getAuthTables } from "better-auth/db"
import { Hono } from "hono"
import type { AuthEnv } from "@/types"

function convertToSnakeCase(str: string) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

const router = new Hono<AuthEnv>().get("/generate", async (c) => {
  const auth = c.get("auth")

  const tables = getAuthTables(auth.options)

  let code = `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
			`

  for (const table in tables) {
    const modelName = `${tables[table].modelName}s`
    const fields = tables[table].fields
    function getType(_name: string, field: DBFieldAttribute) {
      const name = convertToSnakeCase(_name)
      const type = field.type
      const typeMap = {
        string: `text('${name}')`,
        boolean: `integer('${name}', { mode: 'boolean' })`,
        number: `integer('${name}')`,
        date: `integer('${name}', { mode: 'timestamp' })`,
      } as const
      return typeMap[type as keyof typeof typeMap]
    }
    const schema = `export const ${modelName} = sqliteTable("${convertToSnakeCase(
      modelName,
    )}", {\n id: text("id").primaryKey(),\n ${Object.keys(fields)
      .map((field) => {
        const attr = fields[field]
        return `${field}: ${getType(field, attr)}${attr.required ? ".notNull()" : ""}${attr.unique ? ".unique()" : ""}${
          attr.references
            ? `.references(()=> ${attr.references.model}s.${attr.references.field}, { onDelete: 'cascade' })`
            : ""
        }`
      })
      .join(",\n ")}\n});`
    code += `\n${schema}\n`
  }

  return c.text(code)
})

export default router
