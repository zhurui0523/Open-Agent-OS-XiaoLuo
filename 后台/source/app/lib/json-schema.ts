export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
}

export interface SchemaValidationIssue {
  path: string;
  message: string;
}

function matchesType(type: string, value: unknown) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function sameValue(first: unknown, second: unknown) {
  return JSON.stringify(first) === JSON.stringify(second);
}

export function validateJsonSchema(
  schema: JsonSchema | Record<string, unknown> | undefined,
  value: unknown,
  path = "$",
): SchemaValidationIssue[] {
  if (!schema || typeof schema !== "object") return [];
  const typed = schema as JsonSchema;
  const issues: SchemaValidationIssue[] = [];
  const allowedTypes = Array.isArray(typed.type)
    ? typed.type
    : typed.type
      ? [typed.type]
      : [];
  if (
    allowedTypes.length &&
    !allowedTypes.some((type) => matchesType(type, value))
  ) {
    return [{ path, message: `应为 ${allowedTypes.join(" 或 ")}` }];
  }
  if (typed.const !== undefined && !sameValue(value, typed.const)) {
    issues.push({ path, message: "值不符合固定约束" });
  }
  if (
    typed.enum?.length &&
    !typed.enum.some((candidate) => sameValue(candidate, value))
  ) {
    issues.push({ path, message: "值不在允许的选项中" });
  }
  if (typeof value === "string") {
    if (typed.minLength !== undefined && value.length < typed.minLength) {
      issues.push({ path, message: `至少需要 ${typed.minLength} 个字符` });
    }
    if (typed.maxLength !== undefined && value.length > typed.maxLength) {
      issues.push({ path, message: `最多允许 ${typed.maxLength} 个字符` });
    }
    if (typed.pattern) {
      try {
        if (!new RegExp(typed.pattern).test(value)) {
          issues.push({ path, message: "格式不符合要求" });
        }
      } catch {
        issues.push({ path, message: "Schema 的 pattern 无效" });
      }
    }
  }
  if (typeof value === "number") {
    if (typed.minimum !== undefined && value < typed.minimum) {
      issues.push({ path, message: `不能小于 ${typed.minimum}` });
    }
    if (typed.maximum !== undefined && value > typed.maximum) {
      issues.push({ path, message: `不能大于 ${typed.maximum}` });
    }
  }
  if (Array.isArray(value)) {
    if (typed.minItems !== undefined && value.length < typed.minItems) {
      issues.push({ path, message: `至少需要 ${typed.minItems} 项` });
    }
    if (typed.maxItems !== undefined && value.length > typed.maxItems) {
      issues.push({ path, message: `最多允许 ${typed.maxItems} 项` });
    }
    if (
      typed.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      issues.push({ path, message: "数组项目不能重复" });
    }
    if (typed.items) {
      value.forEach((item, index) => {
        issues.push(
          ...validateJsonSchema(typed.items, item, `${path}[${index}]`),
        );
      });
    }
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const object = value as Record<string, unknown>;
    (typed.required ?? []).forEach((key) => {
      if (
        object[key] === undefined ||
        object[key] === null ||
        object[key] === ""
      ) {
        issues.push({ path: `${path}.${key}`, message: "此项必填" });
      }
    });
    Object.entries(typed.properties ?? {}).forEach(([key, property]) => {
      if (object[key] !== undefined) {
        issues.push(
          ...validateJsonSchema(property, object[key], `${path}.${key}`),
        );
      }
    });
  }
  if (typed.oneOf?.length) {
    const matches = typed.oneOf.filter(
      (candidate) => validateJsonSchema(candidate, value, path).length === 0,
    ).length;
    if (matches !== 1) {
      issues.push({ path, message: "必须且只能匹配一种结构" });
    }
  }
  if (
    typed.anyOf?.length &&
    !typed.anyOf.some(
      (candidate) => validateJsonSchema(candidate, value, path).length === 0,
    )
  ) {
    issues.push({ path, message: "没有匹配任何允许的结构" });
  }
  return issues;
}
