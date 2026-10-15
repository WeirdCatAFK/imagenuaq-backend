// Allows two kinds of comment: a short header before any code (what the file does and its
// one gotcha, 1-3 lines) and JSDoc right above a declaration. Everything else is reported;
// eslint directives (`eslint-disable`, `global`) are exempt.

const DOCUMENTABLE = new Set([
  "FunctionDeclaration",
  "ClassDeclaration",
  "VariableDeclaration",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "MethodDefinition",
  "PropertyDefinition",
  "Property",
]);

const DIRECTIVE = /^\s*(eslint(-disable|-enable)?\b|global\s|globals\s|exported\s)/;

/** Whether a JSDoc ending before `token` documents a declaration that starts at that token. */
function documentsDeclaration(sourceCode, token) {
  let node = sourceCode.getNodeByRangeIndex(token.range[0]);
  while (node && node.range[0] === token.range[0]) {
    if (DOCUMENTABLE.has(node.type)) return true;
    node = node.parent;
  }
  return false;
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Allow only the file's opening comment and JSDoc on declarations",
    },
    schema: [],
    messages: {
      notAllowed:
        "Only the file's opening comment and JSDoc on a declaration are allowed. Move this into the header or a JSDoc, or delete it.",
      strayJsdoc: "A JSDoc comment must sit directly above a declaration.",
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;

    return {
      Program() {
        const firstToken = sourceCode.ast.tokens[0];
        const headerEnd = firstToken ? firstToken.range[0] : Infinity;

        for (const comment of sourceCode.getAllComments()) {
          if (comment.type === "Shebang") continue;
          if (comment.range[1] <= headerEnd) continue;
          if (DIRECTIVE.test(comment.value)) continue;

          if (comment.type === "Block" && comment.value.startsWith("*")) {
            const next = sourceCode.getTokenAfter(comment, { includeComments: false });
            if (!next || !documentsDeclaration(sourceCode, next)) {
              context.report({ loc: comment.loc, messageId: "strayJsdoc" });
            }
            continue;
          }

          context.report({ loc: comment.loc, messageId: "notAllowed" });
        }
      },
    };
  },
};
