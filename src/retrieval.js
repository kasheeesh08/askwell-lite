(function attachRetrieval(root) {
  const { tokenize } = root.AskWellUtils;

  function answerQuestion(question, articles = []) {
    const queryTokens = new Set(tokenize(question));
    const scored = articles
      .map((article) => {
        const haystack = tokenize(
          `${article.title} ${(article.tags || []).join(" ")} ${article.content}`,
        );
        const score = haystack.reduce(
          (total, token) => total + (queryTokens.has(token) ? 1 : 0),
          0,
        );
        return { ...article, score };
      })
      .sort((a, b) => b.score - a.score);

    const matches = scored.filter((article) => article.score > 0).slice(0, 2);

    if (!matches.length) {
      return {
        answer:
          "I do not have that in the knowledge base yet. Add an article for this question and I will start answering it here.",
        sources: [],
      };
    }

    return {
      answer: matches.map((article) => article.content).join(" "),
      sources: matches.map((article) => article.title),
    };
  }

  root.AskWellRetrieval = {
    answerQuestion,
  };
})(globalThis);
