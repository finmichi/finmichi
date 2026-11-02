// Minimal HTTP readiness probe for the shell-free third-party Java image.
package main

import (
	"net/http"
	"os"
	"time"
)

func main() {
	client := http.Client{Timeout: 4 * time.Second}
	response, err := client.Get("http://127.0.0.1:8080/isalive")
	if err != nil {
		os.Exit(1)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		os.Exit(1)
	}
}
