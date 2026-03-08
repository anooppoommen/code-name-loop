package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/joho/godotenv"

	"loop/agent/systeminstruction/evals"
)

func main() {
	if err := godotenv.Load(".env"); err != nil {
		log.Printf("prompt_eval: no .env loaded: %v", err)
	}

	if len(os.Args) < 2 {
		log.Fatalf("usage: prompt_eval <generate-suite|run> [flags]")
	}

	switch os.Args[1] {
	case "generate-suite":
		generateSuite(os.Args[2:])
	case "run":
		runSuite(os.Args[2:])
	default:
		log.Fatalf("unknown command %q", os.Args[1])
	}
}

func generateSuite(args []string) {
	fs := flag.NewFlagSet("generate-suite", flag.ExitOnError)
	dbPath := fs.String("db", "loop.db", "path to loop db")
	outPath := fs.String("out", "agent/systeminstruction/evals/recent_conversations.v2.json", "output suite path")
	fs.Parse(args)

	suite, err := evals.GenerateSuite(*dbPath)
	if err != nil {
		log.Fatal(err)
	}
	if err := evals.SaveJSON(*outPath, suite); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("wrote %d cases to %s\n", len(suite.Cases), *outPath)
}

func runSuite(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	suitePath := fs.String("suite", "agent/systeminstruction/evals/recent_conversations.v2.json", "suite path")
	variant := fs.String("variant", "gemini-coding-strict-optimized.v8.json", "embedded prompt variant filename")
	model := fs.String("model", "gemini-3.1-pro-preview", "candidate model")
	judgeModel := fs.String("judge-model", "gemini-3-flash-preview", "judge model")
	outPath := fs.String("out", "agent/systeminstruction/evals/results/latest.json", "results output path")
	caseLimit := fs.Int("limit", 0, "optional case limit")
	caseOffset := fs.Int("offset", 0, "optional case offset")
	parallelism := fs.Int("parallel", 1, "number of cases to score concurrently")
	fs.Parse(args)

	result, err := evals.RunSuite(context.Background(), evals.RunOptions{
		SuitePath:   *suitePath,
		Variant:     *variant,
		Model:       *model,
		JudgeModel:  *judgeModel,
		CaseLimit:   *caseLimit,
		CaseOffset:  *caseOffset,
		Parallelism: *parallelism,
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := evals.SaveJSON(*outPath, result); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("wrote %d scored cases to %s\n", result.CaseCount, *outPath)
	fmt.Printf("avg=%.1f pass_rate=%.1f%%\n", result.Summary.AverageScore, result.Summary.PassRate)
}
