package pushhttp

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/models"
	"github.com/grafana/grafana/pkg/registry"
	"github.com/grafana/grafana/pkg/services/live"
	"github.com/grafana/grafana/pkg/services/live/convert"
	"github.com/grafana/grafana/pkg/services/live/pipeline"
	"github.com/grafana/grafana/pkg/services/live/pushurl"
	"github.com/grafana/grafana/pkg/setting"

	"github.com/grafana/grafana-plugin-sdk-go/data"
)

var (
	logger = log.New("live.push_http")
)

func init() {
	registry.RegisterServiceWithPriority(&Gateway{}, registry.Low)
}

// Gateway receives data and translates it to Grafana Live publications.
type Gateway struct {
	Cfg         *setting.Cfg      `inject:""`
	GrafanaLive *live.GrafanaLive `inject:""`

	converter     *convert.Converter
	ruleProcessor *pipeline.RuleProcessor
}

type fakeStorage struct {
	gLive         *live.GrafanaLive
	frameStorage  *pipeline.FrameStorage
	ruleProcessor *pipeline.RuleProcessor
}

func (f fakeStorage) ListChannelRules(_ context.Context, _ pipeline.ListLiveChannelRuleCommand) ([]*pipeline.LiveChannelRule, error) {
	return []*pipeline.LiveChannelRule{
		{
			OrgId:   1,
			Pattern: "stream/influx/input",
			Converter: pipeline.NewAutoInfluxConverter(pipeline.AutoInfluxConverterConfig{
				FrameFormat: "labels_column",
			}),
		},
		{
			OrgId:   1,
			Pattern: "stream/influx/input/:metric",
			Outputter: pipeline.NewMatchOutput("metric", map[string]pipeline.Outputter{
				"cpu": pipeline.NewMultipleOutputter(
					pipeline.NewManagedStreamOutput(f.gLive),
					pipeline.NewConditionalOutput(
						pipeline.NewNumberCompareCondition("usage_user", "gte", 50),
						pipeline.NewChannelOutput(f.ruleProcessor, pipeline.ChannelOutputConfig{
							Channel: "stream/influx/spikes/cpu",
						}),
					),
				),
				"*": pipeline.NewManagedStreamOutput(f.gLive),
			}),
		},
		{
			OrgId:     1,
			Pattern:   "stream/influx/spikes/cpu",
			Outputter: pipeline.NewManagedStreamOutput(f.gLive),
		},
		{
			OrgId:     1,
			Pattern:   "stream/json/auto",
			Converter: pipeline.NewAutoJsonConverter(pipeline.AutoJsonConverterConfig{}),
			Outputter: pipeline.NewManagedStreamOutput(f.gLive),
		},
		{
			OrgId:   1,
			Pattern: "stream/json/tip",
			Converter: pipeline.NewAutoJsonConverter(pipeline.AutoJsonConverterConfig{
				FieldTips: map[string]pipeline.Field{
					"value3": {
						Name: "value3",
						Type: data.FieldTypeNullableFloat64,
					},
					"value100": {
						Name: "value100",
						Type: data.FieldTypeNullableFloat64,
					},
				},
			}),
			Processor: pipeline.NewDropFieldsProcessor("value2"),
			Outputter: pipeline.NewManagedStreamOutput(f.gLive),
		},
		{
			OrgId:   1,
			Pattern: "stream/json/exact",
			Converter: pipeline.NewExactJsonConverter(pipeline.ExactJsonConverterConfig{
				Fields: []pipeline.Field{
					{
						Name:  "time",
						Type:  data.FieldTypeTime,
						Value: "#{now}",
					},
					{
						Name:  "value1",
						Type:  data.FieldTypeNullableFloat64,
						Value: "$.value1",
					},
					{
						Name:  "value2",
						Type:  data.FieldTypeNullableFloat64,
						Value: "$.value2",
					},
					{
						Name:  "value3",
						Type:  data.FieldTypeNullableFloat64,
						Value: "$.value3",
						Labels: []pipeline.Label{
							{
								Name:  "host",
								Value: "$.host",
							},
						},
					},
					{
						Name:  "value4",
						Type:  data.FieldTypeNullableFloat64,
						Value: "$.value4",
						Config: &data.FieldConfig{
							Thresholds: &data.ThresholdsConfig{
								Mode: data.ThresholdsModeAbsolute,
								Steps: []data.Threshold{
									{
										Value: 2,
										State: "normal",
									},
									{
										Value: 6,
										State: "warning",
									},
									{
										Value: 8,
										State: "critical",
									},
								},
							},
						},
					},
					{
						Name:  "map.red",
						Type:  data.FieldTypeNullableFloat64,
						Value: "$.map.red",
						Labels: []pipeline.Label{
							{
								Name:  "host",
								Value: "$.host",
							},
							{
								Name:  "host2",
								Value: "$.host",
							},
						},
					},
					{
						Name:  "annotation",
						Type:  data.FieldTypeNullableString,
						Value: "$.annotation",
					},
					{
						Name:  "running",
						Type:  data.FieldTypeNullableBool,
						Value: "{JSON.parse(x).status === 'running'}",
					},
					{
						Name:  "num_map_colors",
						Type:  data.FieldTypeNullableFloat64,
						Value: "{Object.keys(JSON.parse(x).map).length}",
					},
				},
			}),
			Outputter: pipeline.NewMultipleOutputter(
				pipeline.NewManagedStreamOutput(f.gLive),
				pipeline.NewRemoteWriteOutput(pipeline.RemoteWriteConfig{
					Enabled:  true,
					Endpoint: os.Getenv("GF_LIVE_REMOTE_WRITE_ENDPOINT"),
					User:     os.Getenv("GF_LIVE_REMOTE_WRITE_USER"),
					Password: os.Getenv("GF_LIVE_REMOTE_WRITE_PASSWORD"),
				}),
				pipeline.NewChangeLogOutput(f.frameStorage, f.ruleProcessor, pipeline.ChangeLogOutputConfig{
					Field:   "value3",
					Channel: "stream/json/exact/value3/changes",
				}),
				pipeline.NewChangeLogOutput(f.frameStorage, f.ruleProcessor, pipeline.ChangeLogOutputConfig{
					Field:   "annotation",
					Channel: "stream/json/exact/annotation/changes",
				}),
				pipeline.NewConditionalOutput(
					pipeline.NewMultipleConditionChecker(
						[]pipeline.ConditionChecker{
							pipeline.NewNumberCompareCondition("value1", "gte", 3.0),
							pipeline.NewNumberCompareCondition("value2", "gte", 3.0),
						},
						pipeline.ConditionAll,
					),
					pipeline.NewChannelOutput(f.ruleProcessor, pipeline.ChannelOutputConfig{
						Channel: "stream/json/exact/condition",
					}),
				),
				pipeline.NewThresholdOutput(f.frameStorage, f.ruleProcessor, pipeline.ThresholdOutputConfig{
					FieldName: "value4",
					Channel:   "stream/json/exact/value4/state",
				}),
			),
		},
		{
			OrgId:   1,
			Pattern: "stream/json/exact/value3/changes",
			Outputter: pipeline.NewMultipleOutputter(
				pipeline.NewManagedStreamOutput(f.gLive),
				pipeline.NewRemoteWriteOutput(pipeline.RemoteWriteConfig{
					Enabled:  true,
					Endpoint: os.Getenv("GF_LIVE_REMOTE_WRITE_ENDPOINT"),
					User:     os.Getenv("GF_LIVE_REMOTE_WRITE_USER"),
					Password: os.Getenv("GF_LIVE_REMOTE_WRITE_PASSWORD"),
				}),
			),
		},
		{
			OrgId:     1,
			Pattern:   "stream/json/exact/annotation/changes",
			Outputter: pipeline.NewManagedStreamOutput(f.gLive),
		},
		{
			OrgId:     1,
			Pattern:   "stream/json/exact/condition",
			Processor: pipeline.NewDropFieldsProcessor("running"),
			Outputter: pipeline.NewManagedStreamOutput(f.gLive),
		},
		{
			OrgId:     1,
			Pattern:   "stream/json/exact/value4/state",
			Outputter: pipeline.NewManagedStreamOutput(f.gLive),
		},
	}, nil
}

// Init Gateway.
func (g *Gateway) Init() error {
	logger.Info("Live Push Gateway initialization")

	g.converter = convert.NewConverter()
	storage := &fakeStorage{gLive: g.GrafanaLive, frameStorage: pipeline.NewFrameStorage()}
	ruleProcessor := pipeline.NewRuleProcessor(pipeline.New(storage))
	storage.ruleProcessor = ruleProcessor
	g.ruleProcessor = ruleProcessor
	return nil
}

// Run Gateway.
func (g *Gateway) Run(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}

func (g *Gateway) Handle(ctx *models.ReqContext) {
	streamID := ctx.Params(":streamId")

	stream, err := g.GrafanaLive.ManagedStreamRunner.GetOrCreateStream(ctx.SignedInUser.OrgId, streamID)
	if err != nil {
		logger.Error("Error getting stream", "error", err)
		ctx.Resp.WriteHeader(http.StatusInternalServerError)
		return
	}

	// TODO Grafana 8: decide which formats to use or keep all.
	urlValues := ctx.Req.URL.Query()
	frameFormat := pushurl.FrameFormatFromValues(urlValues)

	body, err := io.ReadAll(ctx.Req.Request.Body)
	if err != nil {
		logger.Error("Error reading body", "error", err)
		ctx.Resp.WriteHeader(http.StatusInternalServerError)
		return
	}
	logger.Debug("Live Push request",
		"protocol", "http",
		"streamId", streamID,
		"bodyLength", len(body),
		"frameFormat", frameFormat,
	)

	metricFrames, err := g.converter.Convert(body, frameFormat)
	if err != nil {
		logger.Error("Error converting metrics", "error", err, "frameFormat", frameFormat)
		if errors.Is(err, convert.ErrUnsupportedFrameFormat) {
			ctx.Resp.WriteHeader(http.StatusBadRequest)
		} else {
			ctx.Resp.WriteHeader(http.StatusInternalServerError)
		}
		return
	}

	// TODO -- make sure all packets are combined together!
	// interval = "1s" vs flush_interval = "5s"

	for _, mf := range metricFrames {
		err := stream.Push(mf.Key(), mf.Frame())
		if err != nil {
			logger.Error("Error pushing frame", "error", err, "data", string(body))
			ctx.Resp.WriteHeader(http.StatusInternalServerError)
			return
		}
	}
}

func (g *Gateway) HandlePath(ctx *models.ReqContext) {
	streamID := ctx.Params(":streamId")
	path := ctx.Params(":path")

	body, err := io.ReadAll(ctx.Req.Request.Body)
	if err != nil {
		logger.Error("Error reading body", "error", err)
		ctx.Resp.WriteHeader(http.StatusInternalServerError)
		return
	}
	logger.Debug("Live channel push request",
		"protocol", "http",
		"streamId", streamID,
		"path", path,
		"bodyLength", len(body),
	)

	channelID := "stream/" + streamID + "/" + path

	channelFrames, ok, err := g.ruleProcessor.DataToFrames(context.Background(), ctx.OrgId, channelID, body)
	if err != nil {
		logger.Error("Error data to frame", "error", err, "body", string(body))
		ctx.Resp.WriteHeader(http.StatusInternalServerError)
		return
	}
	if !ok {
		logger.Error("No conversion rule for a channel", "error", err, "channel", channelID)
		ctx.Resp.WriteHeader(http.StatusNotFound)
		return
	}

	for _, channelFrame := range channelFrames {
		var processorChannel = channelID
		if channelFrame.Channel != "" {
			processorChannel = channelFrame.Channel
		}
		err = g.ruleProcessor.ProcessFrame(context.Background(), ctx.OrgId, processorChannel, channelFrame.Frame)
		if err != nil {
			logger.Error("Error processing frame", "error", err, "data", string(body))
			ctx.Resp.WriteHeader(http.StatusInternalServerError)
			return
		}
	}
}
