// Package api Grafana HTTP API.
//
// The Grafana backend exposes an HTTP API, the same API is used by the frontend to do
// everything from saving dashboards, creating users and updating data sources.
//
//     Schemes: http, https
//     Host: localhost:10081
//     BasePath: /api
//     Version: 0.0.1
//     License: Apache 2.0 http://www.apache.org/licenses/LICENSE-2.0.html
//     Contact: Grafana Labs<hello@grafana.com> https://grafana.com
//
//     Consumes:
//     - application/json
//
//     Produces:
//     - application/json
//
//     Security:
//     - basic:
//     - api_key:
//
//     SecurityDefinitions:
//     basic:
//          type: basic
//     api_key:
//          type: apiKey
//          name: Authorization
//          in: header
//
// swagger:meta
package apidocs
