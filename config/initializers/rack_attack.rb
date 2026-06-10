class Rack::Attack
  throttle("requests/ip", limit: 300, period: 5.minutes) do |request|
    request.ip
  end

  throttle("login/ip", limit: 20, period: 5.minutes) do |request|
    request.ip if request.path == "/session" && request.post?
  end
end
