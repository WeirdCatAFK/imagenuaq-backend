// The comment policy (CLAUDE.md, Conventions): a file may carry two kinds of comment.
//
//   - Its opening block: any comments before the first token of the file. This is where the
//     module's purpose, the alternatives rejected and the RF-* that forced it are written.
//   - JSDoc (`/** */`) directly above a declaration: a function, class, method, class field,
//     variable, export or object property.
//
// Everything else is reported: `//` and `/* */` comments in bodies, trailing comments, JSX
// comments, section dividers, and a JSDoc block that documents a statement rather than a
// declaration. ESLint's own directives (`eslint-disable`, `global`) are exempt.

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
